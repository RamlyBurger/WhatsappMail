import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

import makeWASocket, {
    Browsers,
    DisconnectReason,
    downloadMediaMessage,
    fetchLatestWaWebVersion,
    useMultiFileAuthState,
    type BaileysEventMap,
    type Chat,
    type ConnectionState as BaileysConnectionState,
    type Contact,
    type MessageUserReceiptUpdate,
    type proto,
    type WAMessage,
    type WAMessageUpdate,
    type WASocket,
    WAMessageStubType,
} from "baileys";
import cors from "cors";
import dotenv from "dotenv";
import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import QRCode from "qrcode";

import {
    contactDisplayName,
    contactSavedName,
    createMetadataActivityMessage,
    isIdentifierLike,
    jidToDisplayName,
    keySignature,
    normalizeMessageReaction,
    normalizeMessageReceipt,
    normalizeInputJid,
    normalizeLocalChat,
    normalizeWAMessage,
    protoKeyFromNormalized,
    stripDeviceSuffix,
    timestampSeconds,
    withMessageReceipt,
    type LocalChatProjection,
    type NormalizedChat,
    type NormalizedMessage,
    type WhatsAppMessageKey,
} from "./normalizers.js";

dotenv.config();

const DEFAULT_PORT = 8787;
const DEFAULT_HOST = "127.0.0.1";

type SessionStatus = "idle" | "connecting" | "qr" | "open" | "closed" | "error";

interface QrSnapshot {
    code: string;
    base64: string;
    generatedAt: number;
}

interface SessionSnapshot {
    status: SessionStatus;
    ownerJid: string | null;
    profileName: string | null;
    profilePictureUrl: string | null;
    lastDisconnectReason: string | null;
    hasAuthState: boolean;
    qr: QrSnapshot | null;
    pairingCode: string | null;
    pairingPhone: string | null;
}

interface AppConfig {
    host: string;
    port: number;
    dataDir: string;
    authDir: string;
    cachePath: string;
    displayName: string;
}

interface SsePayload {
    type: string;
    data: unknown;
}

interface PersistedCache {
    contacts: Array<[string, Contact]>;
    chats: LocalChatProjection[];
    messages: Array<[string, NormalizedMessage[]]>;
}

interface DownloadedMedia {
    buffer: Buffer;
    mimetype: string;
    fileName: string;
    kind: string;
}

class HttpError extends Error {
    constructor(
        readonly status: number,
        message: string,
        readonly details?: unknown,
    ) {
        super(message);
    }
}

function readConfig(): AppConfig {
    const dataDir = resolve(process.env.DATA_DIR ?? "./data");
    return {
        host: process.env.HOST ?? DEFAULT_HOST,
        port: Number(process.env.WHATSAPPMAIL_PORT ?? process.env.WHATSAPPMAIL_PROXY_PORT ?? process.env.PORT ?? DEFAULT_PORT) || DEFAULT_PORT,
        dataDir,
        authDir: resolve(dataDir, "auth"),
        cachePath: resolve(dataDir, "cache.json"),
        displayName: process.env.WHATSAPP_DISPLAY_NAME ?? "WhatsappMail",
    };
}

function routeParam(value: string | string[] | undefined): string {
    return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function asyncHandler<TReq extends Request = Request>(
    handler: (req: TReq, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
    return (req, res, next) => {
        handler(req as TReq, res).catch(next);
    };
}

function mediaKindFromRequest(value: unknown): "image" | "video" | "audio" | "document" | "sticker" {
    return value === "image" || value === "video" || value === "audio" || value === "sticker" ? value : "document";
}

function disconnectCode(lastDisconnect: BaileysConnectionState["lastDisconnect"]): number | null {
    const error = lastDisconnect?.error as { output?: { statusCode?: number } } | undefined;
    return error?.output?.statusCode ?? null;
}

function disconnectReason(lastDisconnect: BaileysConnectionState["lastDisconnect"]): string | null {
    const error = lastDisconnect?.error as { message?: string } | undefined;
    return error?.message ?? null;
}

class SseHub {
    private readonly clients = new Set<Response>();

    public connect(req: Request, res: Response): void {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
        res.flushHeaders();

        this.clients.add(res);
        this.emitTo(res, { type: "local.ready", data: { connected: true } });

        const keepAlive = setInterval(() => {
            res.write(": keep-alive\n\n");
        }, 25000);

        req.on("close", () => {
            clearInterval(keepAlive);
            this.clients.delete(res);
        });
    }

    public publish(payload: SsePayload): void {
        for (const client of this.clients) {
            this.emitTo(client, payload);
        }
    }

    private emitTo(response: Response, payload: SsePayload): void {
        response.write(`event: ${payload.type}\n`);
        response.write(`data: ${JSON.stringify(payload)}\n\n`);
    }
}

class LocalWhatsAppService {
    private socket: WASocket | null = null;
    private connectPromise: Promise<SessionSnapshot> | null = null;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private manualLogout = false;
    private coldHistoryRetryStarted = false;
    private needsHistoryRefresh = false;
    private persistTimer: NodeJS.Timeout | null = null;
    private readonly chats = new Map<string, LocalChatProjection>();
    private readonly contacts = new Map<string, Contact>();
    private readonly messages = new Map<string, NormalizedMessage[]>();
    private readonly rawMessages = new Map<string, WAMessage>();
    private readonly profilePictureRequests = new Set<string>();
    private readonly historyRequests = new Set<string>();
    private readonly ownerAliases = new Set<string>();

    private snapshot: SessionSnapshot = {
        status: "idle",
        ownerJid: null,
        profileName: null,
        profilePictureUrl: null,
        lastDisconnectReason: null,
        hasAuthState: false,
        qr: null,
        pairingCode: null,
        pairingPhone: null,
    };

    constructor(
        private readonly config: AppConfig,
        private readonly hub: SseHub,
    ) {
        this.loadOwnerIdentity();
        this.loadCache();
    }

    private loadOwnerIdentity(): void {
        const credsPath = resolve(this.config.authDir, "creds.json");
        if (!existsSync(credsPath)) {
            return;
        }

        try {
            const creds = JSON.parse(readFileSync(credsPath, "utf8")) as {
                me?: {
                    id?: string;
                    lid?: string;
                    name?: string;
                };
            };
            this.rememberOwnerJid(creds.me?.id);
            this.rememberOwnerJid(creds.me?.lid);
            if (creds.me?.id && !this.snapshot.ownerJid) {
                this.snapshot.ownerJid = stripDeviceSuffix(creds.me.id);
            }
            if (creds.me?.name && !this.snapshot.profileName) {
                this.snapshot.profileName = creds.me.name;
            }
        } catch {
            // Missing or stale credentials only affect display names before reconnect.
        }
    }

    private rememberOwnerJid(value: string | null | undefined): void {
        if (!value) {
            return;
        }

        const jid = value.includes("@") ? stripDeviceSuffix(value) : normalizeInputJid(value);
        if (jid) {
            this.ownerAliases.add(jid);
        }
    }

    private isOwnJid(value: string | null | undefined): boolean {
        if (!value) {
            return false;
        }

        const jid = value.includes("@") ? stripDeviceSuffix(value) : normalizeInputJid(value);
        return Boolean(jid && (this.ownerAliases.has(jid) || stripDeviceSuffix(this.snapshot.ownerJid ?? "") === jid));
    }

    private loadCache(): void {
        if (!existsSync(this.config.cachePath)) {
            return;
        }

        try {
            const cache = JSON.parse(readFileSync(this.config.cachePath, "utf8")) as Partial<PersistedCache>;

            for (const [jid, contact] of cache.contacts ?? []) {
                const aliases = this.contactAliases({
                    ...contact,
                    id: contact.id || jid,
                });
                if (!aliases.length) {
                    continue;
                }

                const preferredAlias = aliases.find((alias) => alias.endsWith("@lid")) ?? aliases[0];
                const existing = aliases
                    .map((alias) => this.contacts.get(alias))
                    .filter((value): value is Contact => Boolean(value))
                    .sort((a, b) => Number(Boolean(contactSavedName(b))) - Number(Boolean(contactSavedName(a))))[0];
                const merged = this.mergeContact(existing, contact, preferredAlias);
                for (const alias of this.contactAliases(merged)) {
                    this.contacts.set(alias, merged);
                }
            }

            const fallbackPinnedJids = this.detectPinnedChatsFromCacheOrder(cache.chats ?? []);
            for (const [chatIndex, chat] of (cache.chats ?? []).entries()) {
                if (!chat.remoteJid) {
                    continue;
                }

                const sourceJid = stripDeviceSuffix(chat.remoteJid);
                const jid = this.canonicalChatJid(sourceJid);
                const fallbackPinned = fallbackPinnedJids.has(sourceJid) || fallbackPinnedJids.has(jid);
                const loadedChat = {
                    ...chat,
                    remoteJid: jid,
                    timestamp: chat.timestamp ?? chat.lastActivity?.timestamp ?? chat.lastMessage?.timestamp ?? 0,
                    metadataTimestamp: chat.metadataTimestamp ?? chat.timestamp ?? chat.lastActivity?.timestamp ?? chat.lastMessage?.timestamp ?? 0,
                    pinned: Boolean(chat.pinned) || fallbackPinned,
                    pinnedTimestamp: chat.pinnedTimestamp ?? (fallbackPinned ? Number.MAX_SAFE_INTEGER - chatIndex : undefined),
                    pinnedRank: chat.pinnedRank ?? (fallbackPinned ? chatIndex : undefined),
                };
                this.removeHiddenActivity(loadedChat);
                this.applyChatName(loadedChat, this.displayNameForJid(jid, loadedChat.name), Boolean(this.savedContactNameForJid(jid)));
                const existing = this.chats.get(jid);
                if (existing) {
                    this.mergeChatInto(existing, loadedChat);
                } else {
                    this.chats.set(jid, loadedChat);
                }
            }

            for (const [jid, list] of cache.messages ?? []) {
                const normalizedJid = this.canonicalChatJid(jid);
                if (!normalizedJid || !Array.isArray(list)) {
                    continue;
                }

                const unique = new Map<string, NormalizedMessage>();
                for (const message of list) {
                    if (!message.id) {
                        continue;
                    }

                    if (this.isHiddenMessage(message)) {
                        continue;
                    }

                    if (normalizedJid.endsWith("@g.us") && !message.fromMe && !message.participant) {
                        this.needsHistoryRefresh = true;
                    }
                    if (message.media && !message.raw) {
                        this.needsHistoryRefresh = true;
                    }

                    const normalizedFromRaw = message.raw
                        ? normalizeWAMessage(message.raw as WAMessage, this.snapshot.ownerJid ?? "")
                        : null;
                    const hydratedMessage = normalizedFromRaw
                        ? {
                            ...message,
                            ...normalizedFromRaw,
                            senderName: message.senderName || normalizedFromRaw.senderName,
                            receipt: normalizedFromRaw.receipt ?? message.receipt,
                        }
                        : message;

                    const cachedMessage = this.normalizeCachedLegacyActivity({
                        ...hydratedMessage,
                        remoteJid: normalizedJid,
                        key: {
                            ...hydratedMessage.key,
                            remoteJid: normalizedJid,
                        },
                    });
                    if (this.isHiddenMessage(cachedMessage)) {
                        continue;
                    }

                    unique.set(message.id, cachedMessage);
                }

                const mergedMessages = new Map<string, NormalizedMessage>();
                for (const existingMessage of this.messages.get(normalizedJid) ?? []) {
                    if (!this.isHiddenMessage(existingMessage)) {
                        mergedMessages.set(existingMessage.id, existingMessage);
                    }
                }
                for (const cachedMessage of unique.values()) {
                    const existingMessage = mergedMessages.get(cachedMessage.id);
                    mergedMessages.set(cachedMessage.id, existingMessage ? this.mergeMessage(existingMessage, cachedMessage) : cachedMessage);
                }

                const messages = [...mergedMessages.values()].sort((a, b) => a.timestamp - b.timestamp);
                this.messages.set(normalizedJid, messages);
                for (const message of messages) {
                    if (message.raw) {
                        this.rawMessages.set(keySignature(message.key), message.raw as WAMessage);
                    }
                }

                this.updateChatActivity(normalizedJid);
            }

            for (const chat of [...this.chats.values()]) {
                this.mergeChatAliasesForJid(chat.remoteJid);
            }
        } catch (error) {
            console.warn("Could not load local WhatsApp cache:", error instanceof Error ? error.message : error);
        }
    }

    private detectPinnedChatsFromCacheOrder(chats: LocalChatProjection[]): Set<string> {
        const pinned = new Set<string>();
        const candidates = chats.slice(0, 3);

        for (const [index, chat] of candidates.entries()) {
            const jid = stripDeviceSuffix(chat.remoteJid);
            const timestamp = chat.lastActivity?.timestamp ?? chat.lastMessage?.timestamp ?? chat.timestamp ?? 0;
            if (!jid || !timestamp) {
                continue;
            }

            const hasNewerLaterChat = chats.slice(index + 1).some((later) => {
                if (later.archived) {
                    return false;
                }

                const laterTimestamp = later.lastActivity?.timestamp ?? later.lastMessage?.timestamp ?? later.timestamp ?? 0;
                return laterTimestamp > timestamp;
            });

            if (hasNewerLaterChat) {
                pinned.add(jid);
            }
        }

        return pinned;
    }

    private queuePersist(): void {
        if (this.persistTimer) {
            clearTimeout(this.persistTimer);
        }

        this.persistTimer = setTimeout(() => {
            this.persistTimer = null;
            this.persistCache();
        }, 500);
    }

    private persistCache(): void {
        try {
            for (const chat of [...this.chats.values()]) {
                this.mergeChatAliasesForJid(chat.remoteJid);
            }

            mkdirSync(this.config.dataDir, { recursive: true });

            const stripMessageRaw = (message: NormalizedMessage): NormalizedMessage => {
                if (message.media || message.reactions?.length || message.forwarded) {
                    return message;
                }

                const { raw, ...rest } = message;
                return rest;
            };

            const stripChatRaw = (chat: LocalChatProjection): LocalChatProjection => {
                const { raw, ...rest } = chat;
                return {
                    ...rest,
                    lastMessage: chat.lastMessage ? stripMessageRaw(chat.lastMessage) : undefined,
                    lastActivity: chat.lastActivity ? stripMessageRaw(chat.lastActivity) : undefined,
                };
            };

            const cache: PersistedCache = {
                contacts: [...this.contacts.entries()],
                chats: [...this.chats.values()].map(stripChatRaw),
                messages: [...this.messages.entries()].map(([jid, messages]) => [
                    jid,
                    messages.filter((message) => !this.isHiddenMessage(message)).slice(-500).map(stripMessageRaw),
                ]),
            };

            writeFileSync(this.config.cachePath, JSON.stringify(cache, null, 2));
        } catch (error) {
            console.warn("Could not write local WhatsApp cache:", error instanceof Error ? error.message : error);
        }
    }

    public async boot(): Promise<void> {
        this.snapshot.hasAuthState = await this.hasAuthState();
        if (this.snapshot.hasAuthState) {
            await this.connect();
        }
    }

    public getSnapshot(): SessionSnapshot {
        return structuredClone(this.snapshot);
    }

    public listChats(options: { q?: string; limit?: number; offset?: number; folder?: string }): { chats: NormalizedChat[]; total: number } {
        if (this.chats.size === 0 && this.snapshot.status === "open") {
            this.scheduleColdHistoryRetry();
        }

        const query = (options.q ?? "").trim().toLowerCase();
        const offset = Math.max(0, options.offset ?? 0);
        const limit = Math.max(1, Math.min(options.limit ?? 100, 200));
        const folder = options.folder ?? "inbox";

        for (const chat of [...this.chats.values()]) {
            this.mergeChatAliasesForJid(chat.remoteJid);
        }

        let sourceChats = [...this.chats.values()]
            .filter((chat) => folder === "archive" ? chat.archived : !chat.archived);

        if (query) {
            sourceChats = sourceChats.filter((chat) => {
                const normalized = normalizeLocalChat(chat);
                return `${normalized.name} ${normalized.subject} ${normalized.snippet}`.toLowerCase().includes(query);
            });
        }

        for (const chat of sourceChats.slice(offset, offset + limit)) {
            this.queueProfilePictureFetch(chat.remoteJid);
            if (this.needsGroupActivityTargetHydration(chat.lastActivity)) {
                this.queueChatHistoryFetch(chat.remoteJid, chat.lastActivity);
            }
        }

        const chats = sourceChats.map((chat) => normalizeLocalChat(this.chatWithResolvedSenders(chat)));
        chats.sort((a, b) => {
            if (a.isPinned !== b.isPinned) {
                return a.isPinned ? -1 : 1;
            }

            if (a.isPinned && b.isPinned) {
                const rankDelta = (a.pinnedRank ?? Number.MAX_SAFE_INTEGER) - (b.pinnedRank ?? Number.MAX_SAFE_INTEGER);
                return rankDelta || (b.pinnedTimestamp ?? 0) - (a.pinnedTimestamp ?? 0) || b.timestamp - a.timestamp;
            }

            return b.sortTimestamp - a.sortTimestamp || b.timestamp - a.timestamp;
        });
        return {
            chats: chats.slice(offset, offset + limit),
            total: chats.length,
        };
    }

    public listMessages(remoteJid: string, page: number, limit: number): { messages: NormalizedMessage[]; total: number } {
        const jid = this.canonicalChatJid(normalizeInputJid(remoteJid));
        this.mergeChatAliasesForJid(jid);
        const chat = this.chats.get(jid);
        const allMessages: NormalizedMessage[] = [...(this.messages.get(jid) ?? [])]
            .filter((message) => !this.isHiddenMessage(message))
            .map((message) => this.messageWithResolvedSender(message, jid, chat))
            .sort((a, b) => a.timestamp - b.timestamp);
        const metadataActivity = chat ? createMetadataActivityMessage(chat) : undefined;
        if (metadataActivity && !allMessages.some((message) => message.id === metadataActivity.id)) {
            metadataActivity.senderName = jid.endsWith("@g.us") ? "Someone" : chat?.name ?? metadataActivity.senderName;
            allMessages.push(metadataActivity);
            allMessages.sort((a, b) => a.timestamp - b.timestamp);
        }
        if (allMessages.some((message) => message.media && !this.rawMessages.has(keySignature(message.key)) && !message.raw)) {
            this.queueChatHistoryFetch(jid);
        }
        const activityNeedingTarget = allMessages.find((message) => this.needsGroupActivityTargetHydration(message));
        if (activityNeedingTarget) {
            this.queueChatHistoryFetch(jid, activityNeedingTarget);
        }
        const safeLimit = Math.max(1, Math.min(limit, 200));
        const end = Math.max(0, allMessages.length - (Math.max(1, page) - 1) * safeLimit);
        const start = Math.max(0, end - safeLimit);
        const messages = allMessages.slice(start, end);
        for (const message of messages) {
            if (jid.endsWith("@g.us") && !message.fromMe && message.participant && !message.senderProfilePicUrl) {
                this.queueContactProfilePictureFetch(message.participant, jid);
            }
            for (const reaction of message.reactions ?? []) {
                if (!reaction.fromMe && reaction.senderJid) {
                    this.queueContactProfilePictureFetch(reaction.senderJid, jid);
                }
            }
        }

        return {
            messages,
            total: allMessages.length,
        };
    }

    public async downloadMedia(remoteJid: string, messageId: string): Promise<DownloadedMedia> {
        const jid = this.canonicalChatJid(normalizeInputJid(remoteJid));
        const message = this.messages.get(jid)?.find((item) => item.id === messageId);
        if (!message?.media) {
            throw new HttpError(404, "Media message was not found.");
        }

        let raw = this.rawMessages.get(keySignature(message.key)) ?? message.raw as WAMessage | undefined;
        if (!raw) {
            this.queueChatHistoryFetch(jid);
            throw new HttpError(404, "Media payload is not available yet. Refresh WhatsApp history and try again.");
        }

        const socket = this.socket;
        const context = socket
            ? {
                reuploadRequest: socket.updateMediaMessage,
                logger: socket.logger,
            }
            : undefined;
        let buffer: Buffer;
        try {
            buffer = Buffer.from(await downloadMediaMessage(raw, "buffer", {}, context));
        } catch (error) {
            if (!socket) {
                throw error;
            }

            raw = await socket.updateMediaMessage(raw);
            this.rawMessages.set(keySignature(message.key), raw);
            message.raw = raw;
            this.queuePersist();
            buffer = Buffer.from(await downloadMediaMessage(raw, "buffer", {}, context));
        }

        return {
            buffer,
            mimetype: message.media.mimetype || "application/octet-stream",
            fileName: message.media.fileName || `${message.id}.${message.media.kind}`,
            kind: message.media.kind,
        };
    }

    public async connect(): Promise<SessionSnapshot> {
        if (this.connectPromise) {
            return this.connectPromise;
        }

        if (this.socket && ["connecting", "qr", "open"].includes(this.snapshot.status)) {
            return this.getSnapshot();
        }

        this.manualLogout = false;
        this.clearReconnectTimer();
        this.updateSnapshot({
            status: "connecting",
            lastDisconnectReason: null,
            qr: null,
        });

        this.connectPromise = this.createSocket()
            .then(() => this.getSnapshot())
            .catch((error) => {
                this.updateSnapshot({
                    status: "error",
                    lastDisconnectReason: error instanceof Error ? error.message : "Could not start WhatsApp session",
                });
                throw error;
            })
            .finally(() => {
                this.connectPromise = null;
            });

        return this.connectPromise;
    }

    public async logout(): Promise<SessionSnapshot> {
        this.manualLogout = true;
        this.clearReconnectTimer();
        this.coldHistoryRetryStarted = false;
        if (this.persistTimer) {
            clearTimeout(this.persistTimer);
            this.persistTimer = null;
        }

        const socket = this.socket;
        this.socket = null;

        try {
            await socket?.logout("User requested logout");
        } catch {
            // Ignore logout failures so local cleanup can still complete.
        }

        try {
            socket?.ws.close();
        } catch {
            // Ignore socket close failures.
        }

        await rm(this.config.authDir, { recursive: true, force: true });
        await rm(this.config.cachePath, { force: true });
        mkdirSync(this.config.authDir, { recursive: true });
        this.chats.clear();
        this.contacts.clear();
        this.messages.clear();
        this.rawMessages.clear();
        this.updateSnapshot({
            status: "closed",
            ownerJid: null,
            profileName: null,
            profilePictureUrl: null,
            qr: null,
            pairingCode: null,
            pairingPhone: null,
            hasAuthState: false,
            lastDisconnectReason: null,
        });

        return this.getSnapshot();
    }

    public async requestPairingCode(phoneNumber: string): Promise<{ code: string; phoneNumber: string; session: SessionSnapshot }> {
        const number = phoneNumber.replace(/[^\d]/g, "");
        if (!number) {
            throw new HttpError(400, "Phone number is required.");
        }

        await this.connect();
        const socket = this.socket;
        if (!socket) {
            throw new HttpError(409, "WhatsApp socket is not ready yet. Try again in a moment.");
        }

        if (socket.authState.creds.registered) {
            throw new HttpError(409, "This local session is already paired.");
        }

        const code = await socket.requestPairingCode(number);
        this.updateSnapshot({
            status: "qr",
            pairingCode: code,
            pairingPhone: number,
        });

        return {
            code,
            phoneNumber: number,
            session: this.getSnapshot(),
        };
    }

    public async sendText(remoteJid: string, text: string): Promise<NormalizedMessage> {
        const socket = this.requireOpenSocket();
        const jid = this.canonicalChatJid(normalizeInputJid(remoteJid));

        await socket.sendPresenceUpdate("composing", jid);
        const result = await socket.sendMessage(jid, { text });
        await socket.sendPresenceUpdate("available", jid);

        const saved = this.saveRawMessage(result, false);
        if (!saved) {
            throw new Error("WhatsApp did not return a message payload after send.");
        }

        this.publishMessagesChanged("messages.upsert");
        return saved;
    }

    public async sendMedia(input: {
        remoteJid: string;
        mediaKind: "image" | "video" | "audio" | "document" | "sticker";
        buffer: Buffer;
        mimetype: string;
        fileName?: string;
        caption?: string;
    }): Promise<NormalizedMessage> {
        const socket = this.requireOpenSocket();
        const jid = this.canonicalChatJid(normalizeInputJid(input.remoteJid));
        const content =
            input.mediaKind === "image"
                ? { image: input.buffer, caption: input.caption || undefined, mimetype: input.mimetype }
                : input.mediaKind === "video"
                  ? { video: input.buffer, caption: input.caption || undefined, mimetype: input.mimetype }
                  : input.mediaKind === "audio"
                    ? { audio: input.buffer, mimetype: input.mimetype, ptt: input.mimetype.includes("ogg") }
                    : input.mediaKind === "sticker"
                      ? { sticker: input.buffer, mimetype: input.mimetype }
                      : {
                            document: input.buffer,
                            mimetype: input.mimetype,
                            fileName: input.fileName || "attachment",
                            caption: input.caption || undefined,
                        };

        const result = await socket.sendMessage(jid, content);
        const saved = this.saveRawMessage(result, false);
        if (!saved) {
            throw new Error("WhatsApp did not return a media message payload after send.");
        }

        this.publishMessagesChanged("messages.upsert");
        return saved;
    }

    public async sendReaction(key: WhatsAppMessageKey, reaction: string): Promise<void> {
        const socket = this.requireOpenSocket();
        await socket.sendMessage(stripDeviceSuffix(key.remoteJid), {
            react: {
                key: protoKeyFromNormalized(key),
                text: reaction,
            },
        });
        this.applyReactionToMessage(protoKeyFromNormalized(key), {
            key: {
                remoteJid: this.snapshot.ownerJid ?? key.remoteJid,
                fromMe: true,
                id: key.id,
            },
            text: reaction,
            senderTimestampMs: Date.now(),
        });
        this.queuePersist();
        this.publishMessagesChanged("messages.update");
    }

    public async markRead(remoteJid: string, key?: WhatsAppMessageKey): Promise<void> {
        const jid = this.canonicalChatJid(normalizeInputJid(remoteJid));
        const chat = this.ensureChat(jid);
        chat.unreadCount = 0;

        if (this.socket && key?.id) {
            await this.socket.readMessages([protoKeyFromNormalized(key)]);
        }

        this.queuePersist();
        this.hub.publish({ type: "messages.update", data: { remoteJid: jid } });
    }

    public async markUnread(remoteJid: string): Promise<void> {
        const jid = this.canonicalChatJid(normalizeInputJid(remoteJid));
        const chat = this.ensureChat(jid);
        chat.unreadCount = Math.max(chat.unreadCount ?? 0, 1);
        this.queuePersist();
        this.hub.publish({ type: "messages.update", data: { remoteJid: jid } });
    }

    public async archiveChat(remoteJid: string, archive: boolean): Promise<void> {
        const jid = this.canonicalChatJid(normalizeInputJid(remoteJid));
        const chat = this.ensureChat(jid);
        chat.archived = archive;

        const lastMessage = chat.lastMessage;
        const chatModify = this.socket ? (this.socket as unknown as { chatModify?: (mod: unknown, jid: string) => Promise<unknown> }).chatModify : undefined;
        if (chatModify && lastMessage) {
            await chatModify({
                archive,
                lastMessages: [{
                    key: protoKeyFromNormalized(lastMessage.key),
                    messageTimestamp: lastMessage.timestamp,
                }],
            }, jid).catch(() => undefined);
        }

        this.queuePersist();
        this.hub.publish({ type: "messages.update", data: { remoteJid: jid } });
    }

    private async createSocket(): Promise<void> {
        const authState = await useMultiFileAuthState(this.config.authDir);
        const shouldRefreshHistory = (
            (!existsSync(this.config.cachePath) && this.chats.size === 0)
            || this.needsHistoryRefresh
        ) && authState.state.creds.processedHistoryMessages.length > 0;

        if (shouldRefreshHistory) {
            authState.state.creds.processedHistoryMessages = [];
            this.needsHistoryRefresh = false;
            await authState.saveCreds();
        }

        const version = await fetchLatestWaWebVersion()
            .then((result) => result.version)
            .catch(() => undefined);

        const socket = makeWASocket({
            auth: authState.state,
            browser: Browsers.macOS("Chrome"),
            ...(version ? { version } : {}),
            printQRInTerminal: false,
            markOnlineOnConnect: false,
            syncFullHistory: true,
            connectTimeoutMs: 30_000,
            keepAliveIntervalMs: 30_000,
            qrTimeout: 60_000,
        });

        this.socket = socket;
        this.snapshot.hasAuthState = true;

        socket.ev.on("creds.update", authState.saveCreds);
        socket.ev.on("connection.update", (update) => {
            void this.handleConnectionUpdate(update);
        });
        socket.ev.on("messaging-history.set", (event) => {
            this.handleHistorySet(event);
        });
        socket.ev.on("chats.upsert", (chats) => {
            this.handleChats(chats);
        });
        socket.ev.on("chats.update", (chats) => {
            this.handleChats(chats);
        });
        socket.ev.on("groups.upsert", (groups) => {
            this.handleGroupsUpdate(groups, false);
        });
        socket.ev.on("groups.update", (groups) => {
            this.handleGroupsUpdate(groups, true);
        });
        socket.ev.on("group-participants.update", (update) => {
            this.handleGroupParticipantsUpdate(update);
        });
        socket.ev.on("contacts.upsert", (contacts) => {
            this.handleContacts(contacts);
        });
        socket.ev.on("contacts.update", (contacts) => {
            this.handleContacts(contacts);
        });
        socket.ev.on("messages.upsert", (event) => {
            this.handleMessagesUpsert(event.messages, event.type);
        });
        socket.ev.on("messages.update", (updates) => {
            this.handleMessageUpdates(updates);
        });
        socket.ev.on("message-receipt.update", (updates) => {
            this.handleMessageReceipts(updates);
        });
        socket.ev.on("messages.reaction", (updates) => {
            this.handleMessageReactions(updates);
        });
        socket.ev.on("call", (updates) => {
            this.handleCallUpdates(updates);
        });
        socket.ev.on("messages.delete", (update) => {
            this.handleMessagesDelete(update);
        });
        socket.ev.on("messages.media-update", () => {
            this.publishMessagesChanged("messages.update");
        });
    }

    private async handleConnectionUpdate(update: Partial<BaileysConnectionState>): Promise<void> {
        if (update.qr) {
            const qr: QrSnapshot = {
                code: update.qr,
                base64: await QRCode.toDataURL(update.qr, {
                    margin: 1,
                    errorCorrectionLevel: "H",
                }),
                generatedAt: Date.now(),
            };
            this.updateSnapshot({ status: "qr", qr, pairingCode: null, pairingPhone: null });
            this.hub.publish({ type: "qrcode.updated", data: qr });
        }

        if (update.connection === "connecting") {
            this.updateSnapshot({ status: this.snapshot.qr ? "qr" : "connecting" });
            return;
        }

        if (update.connection === "open") {
            const ownerJid = this.socket?.user?.id ? stripDeviceSuffix(this.socket.user.id) : this.snapshot.ownerJid;
            const ownerLid = (this.socket?.user as { lid?: string } | undefined)?.lid;
            this.rememberOwnerJid(ownerJid);
            this.rememberOwnerJid(ownerLid);
            const profileName = this.socket?.user?.name ?? this.socket?.user?.verifiedName ?? this.config.displayName;
            let profilePictureUrl: string | null = this.snapshot.profilePictureUrl;

            if (ownerJid && this.socket) {
                profilePictureUrl = (await this.socket.profilePictureUrl(ownerJid, "image").catch(() => null)) ?? null;
            }

            this.updateSnapshot({
                status: "open",
                ownerJid,
                profileName,
                profilePictureUrl,
                qr: null,
                pairingCode: null,
                pairingPhone: null,
                lastDisconnectReason: null,
                hasAuthState: true,
            });
            for (const chat of [...this.chats.values()].slice(0, 100)) {
                this.queueProfilePictureFetch(chat.remoteJid);
            }
            return;
        }

        if (update.connection === "close") {
            const code = disconnectCode(update.lastDisconnect);
            const shouldReconnect =
                !this.manualLogout
                && code !== DisconnectReason.loggedOut
                && code !== DisconnectReason.forbidden
                && code !== DisconnectReason.badSession;

            this.socket = null;
            this.updateSnapshot({
                status: shouldReconnect ? "connecting" : "closed",
                qr: null,
                pairingCode: null,
                pairingPhone: null,
                lastDisconnectReason: disconnectReason(update.lastDisconnect) ?? (code ? `Connection closed with code ${code}` : "Connection closed"),
            });

            console.warn(
                `WhatsApp connection closed. code=${code ?? "unknown"} reconnect=${shouldReconnect} reason=${this.snapshot.lastDisconnectReason ?? "unknown"}`,
            );

            if (shouldReconnect) {
                this.scheduleReconnect();
            }
        }
    }

    private handleHistorySet(event: BaileysEventMap["messaging-history.set"]): void {
        this.handleContacts(event.contacts);
        this.handleChats(event.chats);

        for (const message of event.messages) {
            this.saveRawMessage(message, false);
        }

        this.publishMessagesChanged("messages.upsert");
    }

    private handleContacts(contacts: Partial<Contact>[]): void {
        for (const contact of contacts) {
            if (!contact.id) {
                continue;
            }

            const aliases = this.contactAliases(contact);
            const primaryJid = aliases.find((alias) => alias.endsWith("@s.whatsapp.net")) ?? aliases[0];
            const existing = aliases
                .map((alias) => this.contacts.get(alias))
                .filter((value): value is Contact => Boolean(value))
                .sort((a, b) => Number(Boolean(contactSavedName(b))) - Number(Boolean(contactSavedName(a))))[0];
            const merged = this.mergeContact(existing, contact, primaryJid);

            for (const alias of this.contactAliases(merged)) {
                this.contacts.set(alias, merged);
            }

            const chat = this.mergeChatAliasesForJid(primaryJid)
                ?? this.contactAliases(merged).map((alias) => this.chats.get(alias)).find(Boolean);
            if (chat) {
                const savedName = this.savedContactNameForJid(chat.remoteJid);
                this.applyChatName(chat, savedName ?? contactDisplayName(merged, chat.remoteJid), Boolean(savedName));
                if (typeof merged.imgUrl === "string" && merged.imgUrl && merged.imgUrl !== "changed") {
                    chat.profilePicUrl = merged.imgUrl;
                } else if (merged.imgUrl === "changed") {
                    this.queueProfilePictureFetch(chat.remoteJid);
                }
            }
        }

        this.queuePersist();
    }

    private handleChats(chats: Partial<Chat>[]): void {
        for (const chat of chats) {
            if (!chat.id || chat.id === "status@broadcast") {
                continue;
            }

            this.coldHistoryRetryStarted = false;
            const sourceJid = stripDeviceSuffix(chat.id);
            const jid = this.canonicalChatJid(sourceJid);
            const existing = this.ensureChat(jid);
            const chatRecord = chat as Partial<Chat> & {
                accountLid?: string;
                displayName?: string;
                lid?: string;
                messages?: Array<{ message?: WAMessage } | WAMessage>;
                pinned?: unknown;
                subject?: string;
            };
            const savedName = this.savedContactNameForJid(jid);
            this.applyChatName(existing, savedName ?? this.chatDisplayName(jid, chatRecord), Boolean(savedName || jid.endsWith("@g.us")));
            existing.unreadCount = typeof chat.unreadCount === "number" ? chat.unreadCount : existing.unreadCount;
            existing.metadataTimestamp = Math.max(
                existing.metadataTimestamp ?? 0,
                timestampSeconds(chat.conversationTimestamp),
                timestampSeconds(chat.lastMessageRecvTimestamp),
            );
            existing.archived = typeof chat.archived === "boolean" ? chat.archived : existing.archived;
            const pinValue = chatRecord.pinned ?? (chatRecord as { pin?: unknown }).pin;
            if (pinValue !== undefined && pinValue !== null) {
                const pinnedTimestamp = timestampSeconds(pinValue);
                existing.pinned = pinnedTimestamp > 0 || pinValue === true || pinValue === 1;
                existing.pinnedTimestamp = existing.pinned ? pinnedTimestamp || existing.pinnedTimestamp || Math.floor(Date.now() / 1000) : undefined;
                existing.pinnedRank = existing.pinned ? existing.pinnedRank : undefined;
            }
            existing.raw = {
                ...existing.raw as object,
                ...chat,
                id: jid,
            };
            this.queueProfilePictureFetch(jid);
            this.mergeChatAliasesForJid(jid, { preserveTargetPin: true });

            for (const embeddedMessage of this.embeddedChatMessages(chatRecord)) {
                this.saveRawMessage(embeddedMessage, false);
            }
        }

        this.queuePersist();
        this.hub.publish({ type: "messages.update", data: { chats: true } });
    }

    private handleGroupsUpdate(groups: Array<{
        id?: string;
        subject?: string;
        desc?: string;
        subjectTime?: number;
        descTime?: number;
        announce?: boolean;
        restrict?: boolean;
        memberAddMode?: boolean;
        joinApprovalMode?: boolean;
        author?: string;
        authorPn?: string;
    }>, synthesizeSettings: boolean): void {
        let changed = false;

        for (const group of groups) {
            const jid = group.id ? stripDeviceSuffix(group.id) : "";
            if (!jid) {
                continue;
            }

            const chat = this.ensureChat(jid);
            if (group.subject) {
                this.applyChatName(chat, group.subject, true);
            }
            chat.raw = {
                ...chat.raw as object,
                ...group,
                id: jid,
            };

            const actor = this.activityActor(group.author, group.authorPn);
            if (group.subject && group.subjectTime) {
                changed = this.saveGroupActivity({
                    remoteJid: jid,
                    actor,
                    timestamp: timestampSeconds(group.subjectTime),
                    text: `${actor.label} changed the group name to "${group.subject}"`,
                    suffix: "subject",
                }) || changed;
            }

            if (group.desc !== undefined && group.descTime) {
                changed = this.saveGroupActivity({
                    remoteJid: jid,
                    actor,
                    timestamp: timestampSeconds(group.descTime),
                    text: group.desc ? `${actor.label} changed the group description` : `${actor.label} removed the group description`,
                    suffix: "description",
                }) || changed;
            }

            const settingText = synthesizeSettings ? this.groupSettingActivityText(group) : "";
            if (settingText) {
                changed = this.saveGroupActivity({
                    remoteJid: jid,
                    actor,
                    timestamp: Math.floor(Date.now() / 1000),
                    text: `${actor.label} ${settingText}`,
                    suffix: `settings:${Object.keys(group).sort().join("-")}`,
                }) || changed;
            }

            this.queueProfilePictureFetch(jid);
        }

        this.queuePersist();
        if (changed) {
            this.publishMessagesChanged("messages.upsert");
            return;
        }

        this.hub.publish({ type: "messages.update", data: { chats: true } });
    }

    private handleGroupParticipantsUpdate(update: BaileysEventMap["group-participants.update"]): void {
        const remoteJid = stripDeviceSuffix(update.id || "");
        if (!remoteJid) {
            return;
        }

        const participants = update.participants ?? [];
        if (!participants.length) {
            return;
        }

        this.handleContacts(participants);

        const actor = this.activityActor(update.author, update.authorPn);
        const participantNames = participants.map((participant) => this.participantDisplayName(participant));
        const participantJids = participants.map((participant) => this.participantPrimaryJid(participant)).filter(Boolean);
        const actorIsTarget = participantJids.some((jid) => jid === actor.jid);
        const targets = this.formatNameList(participantNames);
        const timestamp = Math.floor(Date.now() / 1000);

        let text: string;
        switch (update.action) {
            case "add":
                text = `${actor.label} added ${targets}`;
                break;
            case "remove":
                text = actorIsTarget && participantNames.length === 1
                    ? `${participantNames[0]} left`
                    : `${actor.label} removed ${targets}`;
                break;
            case "promote":
                text = `${actor.label} made ${targets} ${participantNames.length === 1 ? "an admin" : "admins"}`;
                break;
            case "demote":
                text = `${actor.label} dismissed ${targets} as ${participantNames.length === 1 ? "admin" : "admins"}`;
                break;
            case "modify":
            default:
                text = `${actor.label} updated ${targets}`;
                break;
        }

        const changed = this.saveGroupActivity({
            remoteJid,
            actor,
            timestamp,
            text,
            suffix: `participants:${update.action}:${participantJids.join(",") || targets}`,
            bumpChat: false,
        });

        this.queuePersist();
        if (changed) {
            this.publishMessagesChanged("messages.upsert");
        }
    }

    private groupSettingActivityText(group: {
        announce?: boolean;
        restrict?: boolean;
        memberAddMode?: boolean;
        joinApprovalMode?: boolean;
    }): string {
        if (typeof group.announce === "boolean") {
            return group.announce ? "changed the group so only admins can send messages" : "changed the group so everyone can send messages";
        }

        if (typeof group.restrict === "boolean") {
            return group.restrict ? "changed the group so only admins can edit group info" : "changed the group so everyone can edit group info";
        }

        if (typeof group.memberAddMode === "boolean") {
            return group.memberAddMode ? "allowed participants to add members" : "limited member adds to admins";
        }

        if (typeof group.joinApprovalMode === "boolean") {
            return group.joinApprovalMode ? "turned on join approval" : "turned off join approval";
        }

        return "";
    }

    private activityActor(author?: string, authorPn?: string): { jid: string; label: string; senderName: string; fromMe: boolean } {
        const ownerJid = this.snapshot.ownerJid ? stripDeviceSuffix(this.snapshot.ownerJid) : "";
        const jid = stripDeviceSuffix(authorPn || author || "");
        const fromMe = this.isOwnJid(jid) || Boolean(ownerJid && jid && ownerJid === jid);
        const fallback = author && author !== jid ? this.groupDisplayNameForJid(stripDeviceSuffix(author)) : undefined;
        const name = fromMe ? "me" : jid ? this.groupDisplayNameForJid(jid, fallback) : fallback ?? "Someone";

        return {
            jid,
            label: fromMe ? "You" : name,
            senderName: name,
            fromMe,
        };
    }

    private participantPrimaryJid(participant: Partial<Contact>): string {
        return this.contactAliases(participant).find((alias) => alias.endsWith("@s.whatsapp.net"))
            ?? this.contactAliases(participant)[0]
            ?? "";
    }

    private participantDisplayName(participant: Partial<Contact>): string {
        const jid = this.participantPrimaryJid(participant);
        const fallback = contactDisplayName(participant, jid);
        if (jid) {
            return this.groupTargetDisplayNameForJid(jid, fallback);
        }

        return fallback && fallback !== "Unknown chat" ? fallback : "Someone";
    }

    private formatNameList(names: string[]): string {
        const clean = names.filter(Boolean);
        if (!clean.length) {
            return "someone";
        }

        if (clean.length <= 2) {
            return clean.join(" and ");
        }

        return `${clean.slice(0, 2).join(", ")} and ${clean.length - 2} others`;
    }

    private saveGroupActivity(options: {
        remoteJid: string;
        actor: { jid: string; senderName: string; fromMe: boolean };
        timestamp: number;
        text: string;
        suffix: string;
        bumpChat?: boolean;
    }): boolean {
        const timestamp = options.timestamp || Math.floor(Date.now() / 1000);
        const id = `group-activity:${options.remoteJid}:${timestamp}:${options.suffix}`;
        return this.saveSyntheticMessage({
            id,
            remoteJid: options.remoteJid,
            fromMe: options.actor.fromMe,
            senderName: options.actor.senderName,
            participant: options.actor.jid || undefined,
            type: "Group activity",
            text: options.text,
            timestamp,
            timeLabel: new Intl.DateTimeFormat("en-US", {
                hour: "numeric",
                minute: "2-digit",
            }).format(new Date(timestamp * 1000)),
            key: {
                id,
                remoteJid: options.remoteJid,
                fromMe: options.actor.fromMe,
                participant: options.actor.jid || undefined,
            },
            activityOnly: true,
            bumpChat: options.bumpChat === true,
        });
    }

    private stubParameterDisplayName(value: string | undefined): string {
        if (!value) {
            return "someone";
        }

        if (!value.includes("@") && !/^\+?\d[\d\s().-]{5,}$/.test(value)) {
            return value;
        }

        if (!value.includes("@")) {
            return "a participant";
        }

        const jid = stripDeviceSuffix(value);
        return this.groupTargetDisplayNameForJid(jid);
    }

    private hydrateStubActivityText(message: NormalizedMessage, raw: WAMessage): void {
        const stubType = raw.messageStubType;
        if (stubType === undefined || stubType === null) {
            return;
        }

        const parameters = raw.messageStubParameters ?? [];
        const targets = this.formatNameList(parameters.map((parameter: string) => this.stubParameterDisplayName(parameter)));
        const actor = message.fromMe ? "You" : this.groupDisplayNameForJid(message.participant ?? "", message.senderName);

        switch (stubType) {
            case WAMessageStubType.GROUP_CREATE:
                message.text = `${actor} created the group`;
                break;
            case WAMessageStubType.GROUP_CHANGE_SUBJECT:
                message.text = `${actor} changed the group name${parameters[0] ? ` to "${parameters[0]}"` : ""}`;
                break;
            case WAMessageStubType.GROUP_CHANGE_ICON:
                message.text = `${actor} changed the group icon`;
                break;
            case WAMessageStubType.GROUP_CHANGE_INVITE_LINK:
                message.text = `${actor} reset the group invite link`;
                break;
            case WAMessageStubType.GROUP_CHANGE_DESCRIPTION:
                message.text = `${actor} changed the group description`;
                break;
            case WAMessageStubType.GROUP_CHANGE_RESTRICT:
            case WAMessageStubType.GROUP_CHANGE_ANNOUNCE:
                message.text = `${actor} changed the group settings`;
                break;
            case WAMessageStubType.GROUP_PARTICIPANT_ADD:
            case WAMessageStubType.GROUP_PARTICIPANT_INVITE:
                message.text = `${actor} added ${targets}`;
                message.bumpChat = false;
                break;
            case WAMessageStubType.GROUP_PARTICIPANT_REMOVE:
                message.text = `${actor} removed ${targets}`;
                message.bumpChat = false;
                break;
            case WAMessageStubType.GROUP_PARTICIPANT_LEAVE:
                message.text = `${targets} left`;
                message.bumpChat = false;
                break;
            case WAMessageStubType.GROUP_PARTICIPANT_PROMOTE:
                message.text = `${actor} made ${targets} ${parameters.length === 1 ? "an admin" : "admins"}`;
                message.bumpChat = false;
                break;
            case WAMessageStubType.GROUP_PARTICIPANT_DEMOTE:
                message.text = `${actor} dismissed ${targets} as ${parameters.length === 1 ? "admin" : "admins"}`;
                message.bumpChat = false;
                break;
            case WAMessageStubType.GROUP_PARTICIPANT_CHANGE_NUMBER:
                message.text = `${this.stubParameterDisplayName(parameters[0])} changed their phone number`;
                message.bumpChat = false;
                break;
            case WAMessageStubType.GROUP_PARTICIPANT_ACCEPT:
            case WAMessageStubType.GROUP_PARTICIPANT_LINKED_GROUP_JOIN:
            case WAMessageStubType.GROUP_PARTICIPANT_JOINED_GROUP_AND_PARENT_GROUP:
                message.text = `${targets} joined`;
                message.bumpChat = false;
                break;
            default:
                break;
        }
    }

    private handleMessagesUpsert(messages: WAMessage[], type: "append" | "notify"): void {
        for (const message of messages) {
            this.saveRawMessage(message, type === "notify");
        }

        this.publishMessagesChanged("messages.upsert");
    }

    private handleMessageUpdates(updates: WAMessageUpdate[]): void {
        for (const update of updates) {
            const jid = update.key.remoteJid ? this.canonicalChatJid(update.key.remoteJid) : "";
            const messageId = update.key.id ?? "";
            if (!jid || !messageId) {
                continue;
            }

            const list = this.messages.get(jid);
            const message = list?.find((item) => item.id === messageId);
            const signature = keySignature({ id: messageId, remoteJid: jid, fromMe: Boolean(update.key.fromMe) });
            const raw = this.rawMessages.get(signature);

            if (update.update.message !== undefined) {
                const mergedRaw = {
                    ...(raw ?? {}),
                    ...update.update,
                    key: {
                        ...(raw?.key ?? {}),
                        ...update.key,
                        remoteJid: jid,
                    },
                } as WAMessage;
                const normalized = normalizeWAMessage(mergedRaw, this.snapshot.ownerJid ?? "");
                if (normalized) {
                    if (!normalized.fromMe) {
                        const senderJid = normalized.participant ?? normalized.remoteJid;
                        normalized.senderName = normalized.remoteJid.endsWith("@g.us")
                            ? this.groupDisplayNameForJid(senderJid, normalized.senderName)
                            : this.displayNameForJid(senderJid, normalized.senderName);
                    }
                    this.hydrateStubActivityText(normalized, mergedRaw);

                    this.rawMessages.set(keySignature(normalized.key), mergedRaw);
                    if (message) {
                        Object.assign(message, {
                            ...message,
                            ...normalized,
                            reactions: message.reactions ?? normalized.reactions,
                            receipt: normalized.receipt ?? message.receipt,
                        });
                    } else {
                        this.saveRawMessage(mergedRaw, false);
                    }
                    this.updateChatActivity(jid);
                }
            }

            if (message && update.update.status !== undefined) {
                const status = update.update.status === null ? undefined : String(update.update.status);
                if (raw) {
                    raw.status = update.update.status;
                    message.raw = raw;
                }
                message.status = status;
                message.receipt = normalizeMessageReceipt(status, raw ?? message.raw, message.fromMe, jid);
            }
        }

        this.queuePersist();
        this.publishMessagesChanged("messages.update");
    }

    private handleMessagesDelete(update: BaileysEventMap["messages.delete"]): void {
        const keys = "keys" in update
            ? update.keys
            : (this.messages.get(this.canonicalChatJid(update.jid)) ?? []).map((message) => message.key);

        let changed = false;
        for (const key of keys) {
            const jid = key.remoteJid ? this.canonicalChatJid(key.remoteJid) : "";
            const messageId = key.id ?? "";
            if (!jid || !messageId) {
                continue;
            }

            const list = this.messages.get(jid);
            const message = list?.find((item) => item.id === messageId);
            if (!message) {
                continue;
            }

            message.type = "Deleted message";
            message.text = message.fromMe ? "You deleted this message" : "This message was deleted";
            message.media = undefined;
            message.forwarded = undefined;
            message.forwardingScore = undefined;
            message.reactions = undefined;
            this.rawMessages.delete(keySignature(message.key));
            this.updateChatActivity(jid);
            changed = true;
        }

        if (!changed) {
            return;
        }

        this.queuePersist();
        this.publishMessagesChanged("messages.update");
    }

    private handleMessageReceipts(updates: MessageUserReceiptUpdate[]): void {
        for (const update of updates) {
            const jid = update.key.remoteJid ? this.canonicalChatJid(update.key.remoteJid) : "";
            const messageId = update.key.id ?? "";
            if (!jid || !messageId) {
                continue;
            }

            const list = this.messages.get(jid);
            const message = list?.find((item) => item.id === messageId);
            if (!message) {
                continue;
            }

            const signature = keySignature({ id: messageId, remoteJid: jid, fromMe: Boolean(update.key.fromMe) });
            const raw = this.rawMessages.get(signature);
            if (raw) {
                raw.userReceipt = this.mergeUserReceipts(raw.userReceipt, [update.receipt]);
                message.raw = raw;
            }

            message.receipt = normalizeMessageReceipt(
                message.status,
                raw ?? { userReceipt: [update.receipt] },
                message.fromMe,
                jid,
            );
        }

        this.queuePersist();
        this.publishMessagesChanged("messages.update");
    }

    private handleMessageReactions(updates: BaileysEventMap["messages.reaction"]): void {
        let changed = false;
        for (const update of updates) {
            changed = this.applyReactionToMessage(update.key, update.reaction) || changed;
        }

        if (!changed) {
            return;
        }

        this.queuePersist();
        this.publishMessagesChanged("messages.update");
    }

    private handleCallUpdates(updates: BaileysEventMap["call"]): void {
        let changed = false;
        for (const update of updates) {
            const remoteJid = this.canonicalChatJid(update.chatId || update.groupJid || update.from || "");
            if (!remoteJid || remoteJid === "status@broadcast") {
                continue;
            }

        const timestamp = Math.max(1, Math.floor(update.date.getTime() / 1000));
            const callerJid = stripDeviceSuffix(update.from || "");
            const fromMe = this.isOwnJid(callerJid);
            const type = update.isVideo ? "Video call" : "Voice call";
            const statusText = update.status === "reject"
                ? `Missed ${type.toLowerCase()}`
                : type;

            changed = this.saveSyntheticMessage({
                id: `call:${update.id || remoteJid}:${timestamp}`,
                remoteJid,
                fromMe,
                senderName: fromMe ? "me" : this.displayNameForJid(callerJid || remoteJid),
                type,
                text: statusText,
                timestamp,
                timeLabel: new Intl.DateTimeFormat("en-US", {
                    hour: "numeric",
                    minute: "2-digit",
                }).format(update.date),
                key: {
                    id: `call:${update.id || timestamp}`,
                    remoteJid,
                    fromMe,
                },
                activityOnly: true,
            }) || changed;
        }

        if (!changed) {
            return;
        }

        this.queuePersist();
        this.publishMessagesChanged("messages.upsert");
    }

    private applyReactionMessage(raw: WAMessage): boolean {
        const reactionMessage = raw.message?.reactionMessage;
        if (!reactionMessage?.key) {
            return false;
        }

        this.applyReactionToMessage(reactionMessage.key, {
            key: raw.key,
            text: reactionMessage.text ?? "",
            senderTimestampMs: timestampSeconds(raw.messageTimestamp) * 1000,
        });
        return true;
    }

    private applyReactionToMessage(targetKey: proto.IMessageKey | WhatsAppMessageKey | null | undefined, reaction: proto.IReaction): boolean {
        const jid = targetKey?.remoteJid ? this.canonicalChatJid(targetKey.remoteJid) : "";
        const messageId = targetKey?.id ?? "";
        if (!jid || !messageId) {
            return false;
        }

        const list = this.messages.get(jid);
        const message = list?.find((item) => item.id === messageId);
        if (!message) {
            return false;
        }

        const actor = this.reactionActorSignature(reaction);
        const normalized = normalizeMessageReaction(reaction, this.snapshot.ownerJid ?? "", jid);
        const existing = message.reactions ?? [];

        if (!normalized) {
            message.reactions = existing.filter((item) => this.normalizedReactionActorSignature(item) !== actor);
        } else {
            normalized.senderName = normalized.fromMe
                ? "me"
                : jid.endsWith("@g.us")
                  ? this.groupDisplayNameForJid(normalized.senderJid ?? "", normalized.senderName)
                  : this.displayNameForJid(normalized.senderJid ?? "", normalized.senderName);

            const index = existing.findIndex((item) => this.normalizedReactionActorSignature(item) === actor);
            message.reactions = index >= 0
                ? existing.map((item, itemIndex) => itemIndex === index ? normalized : item)
                : [...existing, normalized];
        }

        const signature = keySignature(message.key);
        const raw = this.rawMessages.get(signature) ?? message.raw as WAMessage | undefined;
        if (raw) {
            raw.reactions = this.mergeRawReactions(raw.reactions, reaction);
            this.rawMessages.set(signature, raw);
            message.raw = raw;
        }

        return true;
    }

    private reactionActorSignature(reaction: proto.IReaction): string {
        const key = reaction.key ?? {};
        const senderJid = typeof key.participant === "string" && key.participant
            ? key.participant
            : typeof key.remoteJid === "string"
              ? key.remoteJid
              : "";

        return stripDeviceSuffix(senderJid) || (key.fromMe ? "me" : key.id ?? "unknown");
    }

    private normalizedReactionActorSignature(reaction: NonNullable<NormalizedMessage["reactions"]>[number]): string {
        return reaction.senderJid ? stripDeviceSuffix(reaction.senderJid) : reaction.fromMe ? "me" : reaction.senderName ?? "unknown";
    }

    private mergeRawReactions(existing: WAMessage["reactions"] | null | undefined, incoming: proto.IReaction): NonNullable<WAMessage["reactions"]> {
        const actor = this.reactionActorSignature(incoming);
        const merged = new Map<string, proto.IReaction>();

        for (const reaction of existing ?? []) {
            merged.set(this.reactionActorSignature(reaction), reaction);
        }

        if (String(incoming.text ?? "").trim()) {
            merged.set(actor, incoming);
        } else {
            merged.delete(actor);
        }

        return [...merged.values()];
    }

    private normalizeCachedLegacyActivity(message: NormalizedMessage): NormalizedMessage {
        if (message.raw || !message.activityOnly || message.type !== "Group activity") {
            return message;
        }

        const text = message.text.trim();
        const actorWasIncorrectlyMe = message.fromMe && message.participant && !this.isOwnJid(message.participant);
        const actorName = actorWasIncorrectlyMe || (!message.fromMe && message.participant)
            ? this.groupDisplayNameForJid(message.participant ?? "", message.senderName === "me" ? undefined : message.senderName)
            : message.fromMe
              ? "You"
              : message.senderName || "Someone";
        const safeActorName = isIdentifierLike(actorName) || actorName === "WhatsApp user" ? "Someone" : actorName;

        if (/^You added /i.test(text)) {
            return {
                ...message,
                fromMe: false,
                senderName: "Someone",
                text: "Someone added a participant",
                bumpChat: false,
                key: {
                    ...message.key,
                    fromMe: false,
                },
            };
        }

        if (/^\+?[\d\s().-]{7,}\s+joined$/i.test(text) || /^WhatsApp user joined$/i.test(text)) {
            return {
                ...message,
                fromMe: false,
                senderName: "Someone",
                text: "A participant joined",
                bumpChat: false,
                key: {
                    ...message.key,
                    fromMe: false,
                    participant: undefined,
                },
                participant: undefined,
            };
        }

        if (/^You removed /i.test(text)) {
            return {
                ...message,
                fromMe: !actorWasIncorrectlyMe && message.fromMe,
                senderName: actorWasIncorrectlyMe ? safeActorName : message.senderName,
                text: `${actorWasIncorrectlyMe ? safeActorName : "You"} removed WhatsApp user`,
                bumpChat: false,
                key: {
                    ...message.key,
                    fromMe: !actorWasIncorrectlyMe && message.key.fromMe,
                },
            };
        }

        if (/^Someone removed /i.test(text) && message.participant && safeActorName !== "Someone") {
            return {
                ...message,
                fromMe: false,
                senderName: safeActorName,
                text: `${safeActorName} removed WhatsApp user`,
                bumpChat: false,
                key: {
                    ...message.key,
                    fromMe: false,
                    participant: message.participant,
                },
            };
        }

        if (/\bremoved a participant$/i.test(text)) {
            const actorLabel = message.fromMe
                ? "You"
                : safeActorName !== "Someone"
                  ? safeActorName
                  : text.replace(/\s+removed a participant$/i, "").trim() || "Someone";
            return {
                ...message,
                senderName: actorLabel === "You" ? message.senderName : actorLabel,
                text: `${actorLabel} removed WhatsApp user`,
                bumpChat: false,
            };
        }

        if (/\sadded\s\+?[\d\s().-]{7,}$/i.test(text)) {
            return {
                ...message,
                text: text.replace(/\+?[\d\s().-]{7,}$/i, "a participant"),
                bumpChat: false,
            };
        }

        if (/\bchanged their phone number$/i.test(text)) {
            return {
                ...message,
                bumpChat: false,
            };
        }

        if (message.activityOnly && message.type === "Group activity") {
            return {
                ...message,
                bumpChat: false,
            };
        }

        return message;
    }

    private saveSyntheticMessage(message: NormalizedMessage): boolean {
        const jid = this.canonicalChatJid(message.remoteJid);
        if (!jid || !message.id) {
            return false;
        }

        const normalized: NormalizedMessage = {
            ...message,
            remoteJid: jid,
            key: {
                ...message.key,
                remoteJid: jid,
            },
            timeLabel: message.timeLabel || new Intl.DateTimeFormat("en-US", {
                hour: "numeric",
                minute: "2-digit",
            }).format(new Date(message.timestamp * 1000)),
        };

        const current = this.messages.get(jid) ?? [];
        const existingIndex = current.findIndex((item) => item.id === normalized.id);
        if (existingIndex >= 0) {
            current[existingIndex] = {
                ...current[existingIndex],
                ...normalized,
            };
        } else {
            current.push(normalized);
        }
        current.sort((a, b) => a.timestamp - b.timestamp);
        this.messages.set(jid, current);

        this.updateChatActivity(jid);
        this.queueProfilePictureFetch(jid);
        return true;
    }

    private updateChatActivity(remoteJid: string): void {
        const jid = this.canonicalChatJid(remoteJid);
        if (!jid) {
            return;
        }

        const chat = this.ensureChat(jid);
        const current = [...(this.messages.get(jid) ?? [])]
            .filter((message) => !this.isHiddenMessage(message))
            .sort((a, b) => a.timestamp - b.timestamp);
        if (current.length !== (this.messages.get(jid) ?? []).length) {
            this.messages.set(jid, current);
        }
        const latestActivity = current[current.length - 1];
        const latestMessage = [...current].reverse().find((message) => !message.activityOnly);

        if (latestMessage) {
            chat.lastMessage = latestMessage;
        }

        if (latestActivity) {
            chat.lastActivity = latestActivity;
            chat.timestamp = Math.max(chat.timestamp ?? 0, latestActivity.timestamp);
            chat.metadataTimestamp = Math.max(chat.metadataTimestamp ?? 0, latestActivity.timestamp);
        }
    }

    private mergeUserReceipts(existing: WAMessage["userReceipt"] | null | undefined, incoming: NonNullable<WAMessage["userReceipt"]>): NonNullable<WAMessage["userReceipt"]> {
        const merged = new Map<string, NonNullable<WAMessage["userReceipt"]>[number]>();
        for (const receipt of existing ?? []) {
            const key = receipt.userJid ?? JSON.stringify(receipt);
            merged.set(key, receipt);
        }
        for (const receipt of incoming) {
            const key = receipt.userJid ?? JSON.stringify(receipt);
            merged.set(key, {
                ...merged.get(key),
                ...receipt,
            });
        }

        return [...merged.values()];
    }

    private saveRawMessage(raw: WAMessage | undefined, countUnread: boolean): NormalizedMessage | null {
        if (!raw) {
            return null;
        }

        if (this.applyReactionMessage(raw)) {
            this.queuePersist();
            return null;
        }

        const ownerJid = this.snapshot.ownerJid ?? "";
        const normalized = normalizeWAMessage(raw, ownerJid);
        if (!normalized) {
            return null;
        }

        if (this.isHiddenMessage(normalized)) {
            return null;
        }

        const canonicalRemoteJid = this.canonicalChatJid(normalized.remoteJid);
        if (canonicalRemoteJid !== normalized.remoteJid) {
            normalized.remoteJid = canonicalRemoteJid;
            normalized.key = {
                ...normalized.key,
                remoteJid: canonicalRemoteJid,
            };
        }

        if (!normalized.fromMe) {
            const senderJid = normalized.participant ?? normalized.remoteJid;
            normalized.senderName = normalized.remoteJid.endsWith("@g.us")
                ? this.groupDisplayNameForJid(senderJid, normalized.senderName)
                : this.displayNameForJid(senderJid, normalized.senderName);
        }
        this.hydrateStubActivityText(normalized, raw);

        this.coldHistoryRetryStarted = false;
        this.rawMessages.set(keySignature(normalized.key), raw);
        const current = this.messages.get(normalized.remoteJid) ?? [];
        const existingIndex = current.findIndex((message) => message.id === normalized.id);
        const inserted = existingIndex < 0;
        if (existingIndex >= 0) {
            current[existingIndex] = {
                ...current[existingIndex],
                ...normalized,
            };
        } else {
            current.push(normalized);
        }
        current.sort((a, b) => a.timestamp - b.timestamp);
        this.messages.set(normalized.remoteJid, current);

        const chat = this.ensureChat(normalized.remoteJid);
        this.updateChatActivity(normalized.remoteJid);
        if (!normalized.remoteJid.endsWith("@g.us")) {
            const savedName = this.savedContactNameForJid(normalized.remoteJid);
            const latestMessage = chat.lastMessage ?? normalized;
            this.applyChatName(chat, savedName ?? (latestMessage.fromMe ? undefined : latestMessage.senderName), Boolean(savedName));
        }
        this.queueProfilePictureFetch(normalized.remoteJid);
        if (inserted && countUnread && !normalized.fromMe) {
            chat.unreadCount = (chat.unreadCount ?? 0) + 1;
        }

        this.queuePersist();
        return normalized;
    }

    private ensureChat(remoteJid: string): LocalChatProjection {
        const jid = this.canonicalChatJid(remoteJid);
        const existing = this.chats.get(jid);
        if (existing) {
            return existing;
        }

        const chat: LocalChatProjection = {
            remoteJid: jid,
            name: this.displayNameForJid(jid),
            unreadCount: 0,
            timestamp: 0,
            metadataTimestamp: 0,
            archived: false,
        };
        this.chats.set(jid, chat);
        return chat;
    }

    private canonicalChatJid(remoteJid: string | null | undefined): string {
        const jid = remoteJid ? stripDeviceSuffix(remoteJid) : "";
        if (!jid || jid === "status@broadcast" || jid.endsWith("@g.us")) {
            return jid;
        }

        const contact = this.contactForJid(jid);
        if (!contact) {
            return jid;
        }

        const phoneAlias = this.contactAliases(contact).find((alias) => alias.endsWith("@s.whatsapp.net"));
        return phoneAlias ?? jid;
    }

    private chatAliasesForJid(remoteJid: string): string[] {
        const jid = stripDeviceSuffix(remoteJid);
        const contact = this.contactForJid(jid);
        return [...new Set([jid, ...(contact ? this.contactAliases(contact) : [])].filter(Boolean))];
    }

    private isHiddenMessage(message: Pick<NormalizedMessage, "type"> | undefined | null): boolean {
        const type = message?.type;
        return type === "Reaction"
            || type === "associatedChild"
            || type === "associatedChildMessage"
            || type === "album"
            || type === "albumMessage";
    }

    private removeHiddenActivity(chat: LocalChatProjection): void {
        let removed = false;
        if (this.isHiddenMessage(chat.lastMessage)) {
            chat.lastMessage = undefined;
            removed = true;
        }
        if (this.isHiddenMessage(chat.lastActivity)) {
            chat.lastActivity = undefined;
            removed = true;
        }

        if (removed) {
            const timestamp = Math.max(chat.lastActivity?.timestamp ?? 0, chat.lastMessage?.timestamp ?? 0);
            chat.timestamp = timestamp;
            chat.metadataTimestamp = timestamp;
        }
    }

    private mergeChatAliasesForJid(remoteJid: string, options: { preserveTargetPin?: boolean } = {}): LocalChatProjection | undefined {
        const canonicalJid = this.canonicalChatJid(remoteJid);
        if (!canonicalJid) {
            return undefined;
        }

        let target = this.chats.get(canonicalJid);
        for (const alias of this.chatAliasesForJid(canonicalJid)) {
            if (alias === canonicalJid) {
                continue;
            }

            const source = this.chats.get(alias);
            if (!source) {
                this.moveMessagesToChat(alias, canonicalJid);
                continue;
            }

            if (!target) {
                source.remoteJid = canonicalJid;
                this.chats.delete(alias);
                this.chats.set(canonicalJid, source);
                target = source;
            } else {
                this.mergeChatInto(target, source, options);
                this.chats.delete(alias);
            }

            this.moveMessagesToChat(alias, canonicalJid);
        }

        if (target) {
            target.remoteJid = canonicalJid;
            this.updateChatActivity(canonicalJid);
        }

        return target;
    }

    private mergeChatInto(target: LocalChatProjection, source: LocalChatProjection, options: { preserveTargetPin?: boolean } = {}): void {
        this.removeHiddenActivity(source);
        this.removeHiddenActivity(target);

        const savedName = this.savedContactNameForJid(target.remoteJid);
        this.applyChatName(target, savedName ?? source.name, Boolean(savedName));
        target.unreadCount = Math.max(target.unreadCount ?? 0, source.unreadCount ?? 0);
        const sourceContentTimestamp = Math.max(source.lastActivity?.timestamp ?? 0, source.lastMessage?.timestamp ?? 0);
        target.timestamp = Math.max(target.timestamp ?? 0, sourceContentTimestamp);
        target.metadataTimestamp = Math.max(target.metadataTimestamp ?? 0, sourceContentTimestamp);
        target.archived = source.archived ?? target.archived;

        if (!options.preserveTargetPin) {
            const sourcePinScore = source.pinned ? source.pinnedTimestamp ?? 0 : -1;
            const targetPinScore = target.pinned ? target.pinnedTimestamp ?? 0 : -1;
            if (sourcePinScore > targetPinScore || target.pinned === undefined) {
                target.pinned = source.pinned;
                target.pinnedTimestamp = source.pinnedTimestamp;
                target.pinnedRank = source.pinnedRank;
            }
        }

        if (source.profilePicUrl && !target.profilePicUrl) {
            target.profilePicUrl = source.profilePicUrl;
        }
        if (source.lastMessage && (!target.lastMessage || source.lastMessage.timestamp >= target.lastMessage.timestamp)) {
            target.lastMessage = this.messageForChat(source.lastMessage, target.remoteJid);
        }
        if (source.lastActivity && (!target.lastActivity || source.lastActivity.timestamp >= target.lastActivity.timestamp)) {
            target.lastActivity = this.messageForChat(source.lastActivity, target.remoteJid);
        }
        target.raw = {
            ...(target.raw as object | undefined),
            ...(source.raw as object | undefined),
            id: target.remoteJid,
        };
    }

    private moveMessagesToChat(sourceJid: string, targetJid: string): void {
        const source = this.messages.get(sourceJid) ?? [];
        const target = this.messages.get(targetJid) ?? [];
        const merged = new Map<string, NormalizedMessage>();

        for (const message of [...target, ...source]) {
            if (this.isHiddenMessage(message)) {
                continue;
            }

            const normalized = this.messageForChat(message, targetJid);
            const existing = merged.get(normalized.id);
            merged.set(normalized.id, existing ? this.mergeMessage(existing, normalized) : normalized);
        }

        const messages = [...merged.values()].sort((a, b) => a.timestamp - b.timestamp);
        if (messages.length) {
            this.messages.set(targetJid, messages);
        }
        if (sourceJid !== targetJid) {
            this.messages.delete(sourceJid);
        }
    }

    private messageForChat(message: NormalizedMessage, remoteJid: string): NormalizedMessage {
        const raw = message.raw as WAMessage | undefined;
        const normalizedRaw = raw
            ? {
                ...raw,
                key: {
                    ...raw.key,
                    remoteJid,
                },
            } as WAMessage
            : undefined;

        const oldSignature = keySignature(message.key);
        const storedRaw = this.rawMessages.get(oldSignature);
        if (storedRaw && message.key.remoteJid !== remoteJid) {
            this.rawMessages.delete(oldSignature);
            this.rawMessages.set(`${remoteJid}:${message.id}`, {
                ...storedRaw,
                key: {
                    ...storedRaw.key,
                    remoteJid,
                },
            } as WAMessage);
        }

        return {
            ...message,
            remoteJid,
            raw: normalizedRaw ?? message.raw,
            key: {
                ...message.key,
                remoteJid,
            },
        };
    }

    private mergeMessage(existing: NormalizedMessage, incoming: NormalizedMessage): NormalizedMessage {
        return {
            ...existing,
            ...incoming,
            media: incoming.media ?? existing.media,
            reactions: incoming.reactions ?? existing.reactions,
            receipt: incoming.receipt ?? existing.receipt,
            raw: incoming.raw ?? existing.raw,
        };
    }

    private mergeContact(existing: Contact | undefined, incoming: Partial<Contact>, fallbackId: string): Contact {
        return {
            ...(existing ?? { id: fallbackId }),
            ...incoming,
            id: existing?.id ?? incoming.id ?? fallbackId,
            lid: incoming.lid ?? existing?.lid,
            phoneNumber: incoming.phoneNumber ?? existing?.phoneNumber,
            name: incoming.name || existing?.name,
            notify: incoming.notify || existing?.notify,
            verifiedName: incoming.verifiedName || existing?.verifiedName,
            imgUrl: incoming.imgUrl === undefined ? existing?.imgUrl : incoming.imgUrl,
            status: incoming.status ?? existing?.status,
        } as Contact;
    }

    private contactForJid(jid: string): Contact | undefined {
        const normalizedJid = stripDeviceSuffix(jid);
        return this.contacts.get(normalizedJid);
    }

    private chatWithResolvedSenders(chat: LocalChatProjection): LocalChatProjection {
        return {
            ...chat,
            lastMessage: chat.lastMessage ? this.messageWithResolvedSender(chat.lastMessage, chat.remoteJid, chat) : undefined,
            lastActivity: chat.lastActivity ? this.messageWithResolvedSender(chat.lastActivity, chat.remoteJid, chat) : undefined,
        };
    }

    private messageWithResolvedSender(message: NormalizedMessage, remoteJid: string, chat?: LocalChatProjection): NormalizedMessage {
        const jid = stripDeviceSuffix(remoteJid);
        const senderJid = message.fromMe ? this.snapshot.ownerJid ?? "" : message.participant ?? (jid.endsWith("@g.us") ? "" : jid);
        const senderName = message.fromMe
            ? "me"
            : jid.endsWith("@g.us")
              ? this.groupDisplayNameForJid(senderJid, message.senderName)
              : chat?.name ?? this.displayNameForJid(jid, message.senderName);

        return withMessageReceipt({
            ...message,
            senderName,
            senderProfilePicUrl: this.profilePictureUrlForJid(senderJid),
            media: message.media ? {
                ...message.media,
                url: `/api/media/${encodeURIComponent(jid)}/${encodeURIComponent(message.id)}`,
            } : undefined,
            reactions: message.reactions?.map((reaction) => ({
                ...reaction,
                senderName: reaction.fromMe
                    ? "me"
                    : jid.endsWith("@g.us")
                      ? this.groupDisplayNameForJid(reaction.senderJid ?? "", reaction.senderName)
                      : this.displayNameForJid(reaction.senderJid ?? "", reaction.senderName),
            })),
        });
    }

    private savedContactNameForJid(jid: string): string | undefined {
        return contactSavedName(this.contactForJid(jid));
    }

    private displayNameCandidate(value: unknown): string | undefined {
        const text = String(value ?? "").trim();
        return text
            && !isIdentifierLike(text)
            && text !== "WhatsApp user"
            && text !== "Unknown chat"
            && text !== "Someone"
            && text !== "a participant"
            ? text
            : undefined;
    }

    private groupDisplayNameForJid(jid: string, fallback?: string): string {
        const contact = this.contactForJid(jid);
        const record = contact as (Contact & {
            displayName?: string;
            pushName?: string;
            notify?: string;
        }) | undefined;
        const candidates = [
            contactSavedName(contact),
            record?.notify,
            record?.pushName,
            record?.verifiedName,
            record?.displayName,
            record?.name,
            fallback,
        ];

        const candidate = candidates.map((value) => this.displayNameCandidate(value)).find(Boolean);
        if (candidate) {
            return candidate;
        }

        const phoneNumber = typeof contact?.phoneNumber === "string" ? stripDeviceSuffix(contact.phoneNumber) : "";
        if (phoneNumber) {
            return jidToDisplayName(phoneNumber);
        }

        const normalizedJid = stripDeviceSuffix(jid);
        if (normalizedJid.endsWith("@s.whatsapp.net")) {
            return jidToDisplayName(normalizedJid);
        }

        const fallbackText = String(fallback ?? "").trim();
        return fallbackText && fallbackText !== "Someone" && fallbackText !== "WhatsApp user" ? fallbackText : "Someone";
    }

    private groupTargetDisplayNameForJid(jid: string, fallback?: string): string {
        const normalizedJid = stripDeviceSuffix(jid);
        const groupName = this.groupDisplayNameForJid(normalizedJid, fallback);
        if (groupName !== "Someone") {
            return groupName;
        }

        if (normalizedJid.endsWith("@s.whatsapp.net")) {
            return this.displayNameForJid(normalizedJid, fallback);
        }

        if (normalizedJid.endsWith("@lid")) {
            return "WhatsApp user";
        }

        const fallbackName = this.displayNameCandidate(fallback);
        return fallbackName ?? "a participant";
    }

    private displayNameForJid(jid: string, fallback?: string): string {
        const normalizedJid = stripDeviceSuffix(jid);
        const contact = this.contactForJid(jid);
        const savedName = contactSavedName(contact);
        if (savedName) {
            return savedName;
        }

        const candidate = this.displayNameCandidate(fallback);
        if (candidate) {
            return candidate;
        }

        const phoneNumber = typeof contact?.phoneNumber === "string" ? stripDeviceSuffix(contact.phoneNumber) : "";
        if (phoneNumber) {
            return jidToDisplayName(phoneNumber);
        }

        if (normalizedJid.endsWith("@s.whatsapp.net")) {
            return jidToDisplayName(normalizedJid);
        }

        return contactDisplayName(contact, jid);
    }

    private contactAliases(contact: Partial<Contact>): string[] {
        const values = [contact.id, contact.lid, contact.phoneNumber]
            .filter((value): value is string => Boolean(value))
            .map((value) => value.includes("@") ? stripDeviceSuffix(value) : normalizeInputJid(value));

        return [...new Set(values.filter(Boolean))];
    }

    private chatDisplayName(
        jid: string,
        chat: Partial<Chat> & { accountLid?: string; displayName?: string; lid?: string; subject?: string },
    ): string {
        const candidates = [
            chat.name,
            chat.displayName,
            jid.endsWith("@g.us") ? chat.subject : undefined,
            this.displayNameForJid(jid),
            chat.accountLid ? this.displayNameForJid(stripDeviceSuffix(chat.accountLid)) : undefined,
            chat.lid ? this.displayNameForJid(stripDeviceSuffix(chat.lid)) : undefined,
        ];

        return candidates.find((candidate) => candidate && !isIdentifierLike(candidate)) ?? candidates.find(Boolean) ?? contactDisplayName(undefined, jid);
    }

    private applyChatName(chat: LocalChatProjection, candidate: string | undefined, preferred = false): void {
        if (!candidate) {
            return;
        }

        if (preferred || !chat.name || isIdentifierLike(chat.name)) {
            chat.name = candidate;
        }
    }

    private embeddedChatMessages(chat: { messages?: Array<{ message?: WAMessage } | WAMessage> }): WAMessage[] {
        if (!Array.isArray(chat.messages)) {
            return [];
        }

        return chat.messages
            .map((item) => {
                const record = item as { key?: unknown; message?: unknown };
                return record.key ? item as WAMessage : record.message as WAMessage | undefined;
            })
            .filter((message): message is WAMessage => Boolean(message?.key?.remoteJid && message.key.id));
    }

    private validProfilePictureUrl(value: unknown): string | undefined {
        return typeof value === "string" && value && value !== "changed" ? value : undefined;
    }

    private profilePictureUrlForJid(jid: string | null | undefined): string | undefined {
        const normalizedJid = jid ? stripDeviceSuffix(jid) : "";
        if (!normalizedJid) {
            return undefined;
        }

        if (this.isOwnJid(normalizedJid)) {
            return this.snapshot.profilePictureUrl ?? undefined;
        }

        const contact = this.contactForJid(normalizedJid);
        const contactPhoto = this.validProfilePictureUrl((contact as { imgUrl?: unknown } | undefined)?.imgUrl);
        if (contactPhoto) {
            return contactPhoto;
        }

        const chatPhoto = this.validProfilePictureUrl(this.chats.get(this.canonicalChatJid(normalizedJid))?.profilePicUrl);
        return chatPhoto;
    }

    private profilePictureLookupJid(jid: string): string {
        const normalizedJid = stripDeviceSuffix(jid);
        const contact = this.contactForJid(normalizedJid);
        return this.contactAliases(contact ?? { id: normalizedJid }).find((alias) => alias.endsWith("@s.whatsapp.net"))
            ?? normalizedJid;
    }

    private queueProfilePictureFetch(remoteJid: string): void {
        const jid = stripDeviceSuffix(remoteJid);
        if (!jid || jid === "status@broadcast" || this.profilePictureRequests.has(jid)) {
            return;
        }

        const chat = this.chats.get(jid);
        if (!chat || chat.profilePicUrl || !this.socket || this.snapshot.status !== "open") {
            return;
        }

        this.profilePictureRequests.add(jid);
        void this.socket.profilePictureUrl(jid, "image")
            .then((url) => {
                if (!url) {
                    return;
                }

                chat.profilePicUrl = url;
                this.queuePersist();
                this.hub.publish({ type: "messages.update", data: { remoteJid: jid, profilePicUrl: true } });
            })
            .catch(() => undefined)
            .finally(() => {
                setTimeout(() => {
                    this.profilePictureRequests.delete(jid);
                }, 10 * 60 * 1000);
            });
    }

    private queueContactProfilePictureFetch(remoteJid: string, notifyRemoteJid?: string): void {
        const originalJid = stripDeviceSuffix(remoteJid);
        const lookupJid = this.profilePictureLookupJid(originalJid);
        if (
            !lookupJid
            || lookupJid === "status@broadcast"
            || lookupJid.endsWith("@g.us")
            || this.profilePictureRequests.has(lookupJid)
            || this.profilePictureUrlForJid(originalJid)
            || !this.socket
            || this.snapshot.status !== "open"
        ) {
            return;
        }

        this.profilePictureRequests.add(lookupJid);
        void this.socket.profilePictureUrl(lookupJid, "image")
            .then((url) => {
                if (!url) {
                    return;
                }

                const existing = this.contactForJid(originalJid) ?? this.contactForJid(lookupJid);
                const merged = this.mergeContact(existing, {
                    id: existing?.id ?? lookupJid,
                    imgUrl: url,
                }, lookupJid);
                for (const alias of this.contactAliases(merged)) {
                    this.contacts.set(alias, merged);
                }

                const chat = this.chats.get(this.canonicalChatJid(lookupJid));
                if (chat) {
                    chat.profilePicUrl = url;
                }

                this.queuePersist();
                this.hub.publish({
                    type: "messages.update",
                    data: {
                        changed: true,
                        remoteJid: notifyRemoteJid ? stripDeviceSuffix(notifyRemoteJid) : this.canonicalChatJid(lookupJid),
                        profilePicUrl: true,
                    },
                });
            })
            .catch(() => undefined)
            .finally(() => {
                setTimeout(() => {
                    this.profilePictureRequests.delete(lookupJid);
                }, 10 * 60 * 1000);
            });
    }

    private needsGroupActivityTargetHydration(message: NormalizedMessage | undefined): boolean {
        if (!message?.activityOnly || message.type !== "Group activity" || message.raw) {
            return false;
        }

        return /\b(added|removed|made|dismissed|updated)\s+(a participant|WhatsApp user)\b/i.test(message.text);
    }

    private queueChatHistoryFetch(remoteJid: string, preferredAnchor?: NormalizedMessage): void {
        const jid = stripDeviceSuffix(remoteJid);
        if (!jid || this.historyRequests.has(jid) || !this.socket || this.snapshot.status !== "open") {
            return;
        }

        const messages = [...(this.messages.get(jid) ?? [])].sort((a, b) => b.timestamp - a.timestamp);
        const anchor = preferredAnchor?.id && preferredAnchor.timestamp
            ? preferredAnchor
            : messages.find((message) => this.needsGroupActivityTargetHydration(message) && message.id && message.timestamp)
              ?? messages.find((message) => message.id && message.timestamp);
        if (!anchor) {
            return;
        }

        this.historyRequests.add(jid);
        void this.socket.fetchMessageHistory(50, protoKeyFromNormalized(anchor.key), anchor.timestamp)
            .catch(() => undefined)
            .finally(() => {
                setTimeout(() => {
                    this.historyRequests.delete(jid);
                }, 60_000);
            });
    }

    private updateSnapshot(patch: Partial<SessionSnapshot>): void {
        this.snapshot = {
            ...this.snapshot,
            ...patch,
        };
        this.hub.publish({ type: "connection.update", data: this.getSnapshot() });
    }

    private publishMessagesChanged(type: "messages.upsert" | "messages.update"): void {
        this.hub.publish({ type, data: { changed: true } });
    }

    private requireOpenSocket(): WASocket {
        if (!this.socket || this.snapshot.status !== "open") {
            throw new HttpError(409, "WhatsApp is not connected. Open the connection panel and scan the QR code first.");
        }

        return this.socket;
    }

    private async hasAuthState(): Promise<boolean> {
        try {
            return (await readdir(this.config.authDir)).length > 0;
        } catch {
            return false;
        }
    }

    private scheduleReconnect(): void {
        this.clearReconnectTimer();
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            void this.connect().catch((error) => {
                this.updateSnapshot({
                    status: "error",
                    lastDisconnectReason: error instanceof Error ? error.message : "Reconnect failed",
                });
            });
        }, 3000);
    }

    private scheduleColdHistoryRetry(): void {
        if (this.coldHistoryRetryStarted || existsSync(this.config.cachePath)) {
            return;
        }

        this.coldHistoryRetryStarted = true;
        setTimeout(() => {
            if (this.chats.size > 0 || this.snapshot.status !== "open") {
                return;
            }

            const socket = this.socket;
            this.socket = null;
            try {
                socket?.ws.close();
            } catch {
                // The reconnect path below will create a fresh socket regardless.
            }

            this.updateSnapshot({ status: "connecting" });
            void this.createSocket().catch((error) => {
                this.updateSnapshot({
                    status: "error",
                    lastDisconnectReason: error instanceof Error ? error.message : "Could not retry WhatsApp history sync",
                });
            });
        }, 1000);
    }

    private clearReconnectTimer(): void {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }
}

const config = readConfig();
mkdirSync(config.dataDir, { recursive: true });
mkdirSync(config.authDir, { recursive: true });

const app = express();
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 50 * 1024 * 1024,
    },
});
const hub = new SseHub();
const whatsapp = new LocalWhatsAppService(config, hub);

app.use(cors());
app.use(express.json({ limit: "10mb" }));

app.get("/api/health", (req, res) => {
    const session = whatsapp.getSnapshot();
    res.json({
        ok: true,
        service: "whatsappmail-local",
        mode: "local-baileys",
        configured: true,
        instanceName: config.displayName,
        apiUrl: null,
        dataDir: config.dataDir,
        websocket: {
            globalConnected: true,
            instanceConnected: session.status === "open",
        },
        missing: {},
    });
});

app.get("/api/connection", (req, res) => {
    const session = whatsapp.getSnapshot();
    res.json({
        configured: true,
        instanceName: config.displayName,
        state: session.status,
        message: session.lastDisconnectReason ?? undefined,
        qrcode: session.qr,
        pairingCode: session.pairingCode,
        pairingPhone: session.pairingPhone,
        ownerJid: session.ownerJid,
        profileName: session.profileName,
        profilePictureUrl: session.profilePictureUrl,
        hasAuthState: session.hasAuthState,
    });
});

app.post("/api/connect", asyncHandler(async (req, res) => {
    const session = await whatsapp.connect();
    res.json({
        configured: true,
        instanceName: config.displayName,
        state: session.status,
        message: session.lastDisconnectReason ?? undefined,
        qrcode: session.qr,
        pairingCode: session.pairingCode,
        pairingPhone: session.pairingPhone,
        ownerJid: session.ownerJid,
        profileName: session.profileName,
        profilePictureUrl: session.profilePictureUrl,
        hasAuthState: session.hasAuthState,
    });
}));

app.post("/api/pairing-code", asyncHandler(async (req, res) => {
    const phoneNumber = String(req.body?.phoneNumber ?? "");
    const result = await whatsapp.requestPairingCode(phoneNumber);
    res.json({
        configured: true,
        instanceName: config.displayName,
        state: result.session.status,
        qrcode: result.session.qr,
        pairingCode: result.code,
        pairingPhone: result.phoneNumber,
        ownerJid: result.session.ownerJid,
        profileName: result.session.profileName,
        profilePictureUrl: result.session.profilePictureUrl,
        hasAuthState: result.session.hasAuthState,
    });
}));

app.post("/api/logout", asyncHandler(async (req, res) => {
    const session = await whatsapp.logout();
    res.json({
        configured: true,
        instanceName: config.displayName,
        state: session.status,
    });
}));

app.get("/api/chats", (req, res) => {
    res.json(whatsapp.listChats({
        folder: String(req.query.folder ?? "inbox"),
        q: String(req.query.q ?? ""),
        limit: Number(req.query.limit ?? 100),
        offset: Number(req.query.offset ?? 0),
    }));
});

app.get("/api/chats/:remoteJid/messages", (req, res) => {
    res.json(whatsapp.listMessages(
        routeParam(req.params.remoteJid),
        Number(req.query.page ?? 1),
        Number(req.query.limit ?? 80),
    ));
});

app.get("/api/media/:remoteJid/:messageId", asyncHandler(async (req, res) => {
    const media = await whatsapp.downloadMedia(routeParam(req.params.remoteJid), routeParam(req.params.messageId));
    res.setHeader("Content-Type", media.mimetype);
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(media.fileName)}"`);
    res.send(media.buffer);
}));

app.post("/api/messages/text", asyncHandler(async (req, res) => {
    const remoteJid = String(req.body?.remoteJid ?? "");
    const text = String(req.body?.text ?? "").trim();
    if (!remoteJid || !text) {
        throw new HttpError(400, "remoteJid and text are required.");
    }

    const message = await whatsapp.sendText(remoteJid, text);
    res.status(201).json({ message });
}));

app.post("/api/messages/media", upload.single("file"), asyncHandler(async (req, res) => {
    const remoteJid = String(req.body?.remoteJid ?? "");
    if (!remoteJid || !req.file) {
        throw new HttpError(400, "remoteJid and file are required.");
    }

    const message = await whatsapp.sendMedia({
        remoteJid,
        mediaKind: mediaKindFromRequest(req.body?.mediatype),
        buffer: req.file.buffer,
        mimetype: req.file.mimetype || "application/octet-stream",
        fileName: String(req.body?.fileName || req.file.originalname || "attachment"),
        caption: typeof req.body?.caption === "string" ? req.body.caption : undefined,
    });
    res.status(201).json({ message });
}));

app.post("/api/messages/reaction", asyncHandler(async (req, res) => {
    const key = req.body?.key as WhatsAppMessageKey | undefined;
    const reaction = String(req.body?.reaction ?? "");
    if (!key?.id || !key.remoteJid) {
        throw new HttpError(400, "message key is required.");
    }

    await whatsapp.sendReaction(key, reaction);
    res.status(201).json({ ok: true });
}));

app.post("/api/chats/:remoteJid/read", asyncHandler(async (req, res) => {
    await whatsapp.markRead(routeParam(req.params.remoteJid), req.body?.key);
    res.json({ ok: true });
}));

app.post("/api/chats/:remoteJid/unread", asyncHandler(async (req, res) => {
    await whatsapp.markUnread(routeParam(req.params.remoteJid));
    res.json({ ok: true });
}));

app.post("/api/chats/:remoteJid/archive", asyncHandler(async (req, res) => {
    await whatsapp.archiveChat(routeParam(req.params.remoteJid), req.body?.archive !== false);
    res.json({ ok: true });
}));

app.get("/events", (req, res) => {
    hub.connect(req, res);
});

app.use((error: unknown, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
        next(error);
        return;
    }

    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof Error ? error.message : "Unexpected server error";
    res.status(status).json({
        error: true,
        message,
        details: error instanceof HttpError ? error.details : undefined,
    });
});

void whatsapp.boot().catch((error) => {
    console.warn("Could not auto-start WhatsApp session:", error instanceof Error ? error.message : error);
});

app.listen(config.port, config.host, () => {
    console.log(`WhatsappMail local server listening on http://${config.host}:${config.port}`);
    console.log(`Local WhatsApp auth data: ${config.authDir}`);
});
