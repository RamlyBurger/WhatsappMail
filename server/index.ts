import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

import makeWASocket, {
    Browsers,
    DisconnectReason,
    fetchLatestWaWebVersion,
    useMultiFileAuthState,
    type BaileysEventMap,
    type Chat,
    type ConnectionState as BaileysConnectionState,
    type Contact,
    type WAMessage,
    type WAMessageUpdate,
    type WASocket,
} from "baileys";
import cors from "cors";
import dotenv from "dotenv";
import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import QRCode from "qrcode";

import {
    contactDisplayName,
    isIdentifierLike,
    keySignature,
    normalizeInputJid,
    normalizeLocalChat,
    normalizeWAMessage,
    protoKeyFromNormalized,
    stripDeviceSuffix,
    timestampSeconds,
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
    private persistTimer: NodeJS.Timeout | null = null;
    private readonly chats = new Map<string, LocalChatProjection>();
    private readonly contacts = new Map<string, Contact>();
    private readonly messages = new Map<string, NormalizedMessage[]>();
    private readonly rawMessages = new Map<string, WAMessage>();

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
        this.loadCache();
    }

    private loadCache(): void {
        if (!existsSync(this.config.cachePath)) {
            return;
        }

        try {
            const cache = JSON.parse(readFileSync(this.config.cachePath, "utf8")) as Partial<PersistedCache>;

            for (const [jid, contact] of cache.contacts ?? []) {
                const normalizedJid = stripDeviceSuffix(jid);
                if (normalizedJid) {
                    this.contacts.set(normalizedJid, contact);
                }
            }

            for (const chat of cache.chats ?? []) {
                if (!chat.remoteJid) {
                    continue;
                }

                const jid = stripDeviceSuffix(chat.remoteJid);
                this.chats.set(jid, {
                    ...chat,
                    remoteJid: jid,
                    timestamp: chat.timestamp ?? chat.lastMessage?.timestamp ?? 0,
                    metadataTimestamp: chat.metadataTimestamp ?? chat.timestamp ?? chat.lastMessage?.timestamp ?? 0,
                });
            }

            for (const [jid, list] of cache.messages ?? []) {
                const normalizedJid = stripDeviceSuffix(jid);
                if (!normalizedJid || !Array.isArray(list)) {
                    continue;
                }

                const unique = new Map<string, NormalizedMessage>();
                for (const message of list) {
                    if (!message.id) {
                        continue;
                    }

                    unique.set(message.id, {
                        ...message,
                        remoteJid: normalizedJid,
                        key: {
                            ...message.key,
                            remoteJid: normalizedJid,
                        },
                    });
                }

                const messages = [...unique.values()].sort((a, b) => a.timestamp - b.timestamp);
                this.messages.set(normalizedJid, messages);

                const latest = messages[messages.length - 1];
                if (latest) {
                    const chat = this.ensureChat(normalizedJid);
                    chat.lastMessage = latest;
                    chat.timestamp = Math.max(chat.timestamp ?? 0, latest.timestamp);
                    chat.metadataTimestamp = Math.max(chat.metadataTimestamp ?? 0, latest.timestamp);
                }
            }
        } catch (error) {
            console.warn("Could not load local WhatsApp cache:", error instanceof Error ? error.message : error);
        }
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
            mkdirSync(this.config.dataDir, { recursive: true });

            const stripMessageRaw = (message: NormalizedMessage): NormalizedMessage => {
                const { raw, ...rest } = message;
                return rest;
            };

            const stripChatRaw = (chat: LocalChatProjection): LocalChatProjection => {
                const { raw, ...rest } = chat;
                return {
                    ...rest,
                    lastMessage: chat.lastMessage ? stripMessageRaw(chat.lastMessage) : undefined,
                };
            };

            const cache: PersistedCache = {
                contacts: [...this.contacts.entries()],
                chats: [...this.chats.values()].map(stripChatRaw),
                messages: [...this.messages.entries()].map(([jid, messages]) => [
                    jid,
                    messages.slice(-500).map(stripMessageRaw),
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

        let chats = [...this.chats.values()]
            .filter((chat) => folder === "archive" ? chat.archived : !chat.archived)
            .map((chat) => normalizeLocalChat(chat));

        if (query) {
            chats = chats.filter((chat) => `${chat.name} ${chat.subject} ${chat.snippet}`.toLowerCase().includes(query));
        }

        chats.sort((a, b) => b.timestamp - a.timestamp);
        return {
            chats: chats.slice(offset, offset + limit),
            total: chats.length,
        };
    }

    public listMessages(remoteJid: string, page: number, limit: number): { messages: NormalizedMessage[]; total: number } {
        const jid = normalizeInputJid(remoteJid);
        const allMessages = [...(this.messages.get(jid) ?? [])].sort((a, b) => a.timestamp - b.timestamp);
        const safeLimit = Math.max(1, Math.min(limit, 200));
        const end = Math.max(0, allMessages.length - (Math.max(1, page) - 1) * safeLimit);
        const start = Math.max(0, end - safeLimit);
        const messages = allMessages.slice(start, end);

        return {
            messages,
            total: allMessages.length,
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
        const jid = normalizeInputJid(remoteJid);

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
        const jid = normalizeInputJid(input.remoteJid);
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
        this.publishMessagesChanged("messages.update");
    }

    public async markRead(remoteJid: string, key?: WhatsAppMessageKey): Promise<void> {
        const jid = normalizeInputJid(remoteJid);
        const chat = this.ensureChat(jid);
        chat.unreadCount = 0;

        if (this.socket && key?.id) {
            await this.socket.readMessages([protoKeyFromNormalized(key)]);
        }

        this.queuePersist();
        this.hub.publish({ type: "messages.update", data: { remoteJid: jid } });
    }

    public async markUnread(remoteJid: string): Promise<void> {
        const jid = normalizeInputJid(remoteJid);
        const chat = this.ensureChat(jid);
        chat.unreadCount = Math.max(chat.unreadCount ?? 0, 1);
        this.queuePersist();
        this.hub.publish({ type: "messages.update", data: { remoteJid: jid } });
    }

    public async archiveChat(remoteJid: string, archive: boolean): Promise<void> {
        const jid = normalizeInputJid(remoteJid);
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
        if (!existsSync(this.config.cachePath) && this.chats.size === 0 && authState.state.creds.processedHistoryMessages.length > 0) {
            authState.state.creds.processedHistoryMessages = [];
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
        socket.ev.on("messages.delete", () => {
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
            const primaryJid = aliases[0];
            const merged = {
                ...this.contacts.get(primaryJid),
                ...contact,
                id: primaryJid,
            } as Contact;

            for (const alias of aliases) {
                this.contacts.set(alias, merged);
            }

            const chat = aliases.map((alias) => this.chats.get(alias)).find(Boolean);
            if (chat) {
                this.applyChatName(chat, contactDisplayName(merged, chat.remoteJid));
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
            const jid = stripDeviceSuffix(chat.id);
            const existing = this.ensureChat(jid);
            const chatRecord = chat as Partial<Chat> & {
                accountLid?: string;
                displayName?: string;
                lid?: string;
                messages?: Array<{ message?: WAMessage } | WAMessage>;
                subject?: string;
            };
            this.applyChatName(existing, this.chatDisplayName(jid, chatRecord));
            existing.unreadCount = typeof chat.unreadCount === "number" ? chat.unreadCount : existing.unreadCount;
            existing.metadataTimestamp = Math.max(
                existing.metadataTimestamp ?? 0,
                timestampSeconds(chat.conversationTimestamp),
                timestampSeconds(chat.lastMessageRecvTimestamp),
            );
            existing.archived = typeof chat.archived === "boolean" ? chat.archived : existing.archived;
            existing.raw = {
                ...existing.raw as object,
                ...chat,
                id: jid,
            };

            for (const embeddedMessage of this.embeddedChatMessages(chatRecord)) {
                this.saveRawMessage(embeddedMessage, false);
            }
        }

        this.queuePersist();
        this.hub.publish({ type: "messages.update", data: { chats: true } });
    }

    private handleMessagesUpsert(messages: WAMessage[], type: "append" | "notify"): void {
        for (const message of messages) {
            this.saveRawMessage(message, type === "notify");
        }

        this.publishMessagesChanged("messages.upsert");
    }

    private handleMessageUpdates(updates: WAMessageUpdate[]): void {
        for (const update of updates) {
            const jid = update.key.remoteJid ? stripDeviceSuffix(update.key.remoteJid) : "";
            const messageId = update.key.id ?? "";
            if (!jid || !messageId) {
                continue;
            }

            const list = this.messages.get(jid);
            const message = list?.find((item) => item.id === messageId);
            if (message && update.update.status !== undefined) {
                message.status = String(update.update.status);
            }
        }

        this.queuePersist();
        this.publishMessagesChanged("messages.update");
    }

    private saveRawMessage(raw: WAMessage | undefined, countUnread: boolean): NormalizedMessage | null {
        if (!raw) {
            return null;
        }

        const ownerJid = this.snapshot.ownerJid ?? "";
        const normalized = normalizeWAMessage(raw, ownerJid);
        if (!normalized) {
            return null;
        }

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
        const latest = current[current.length - 1] ?? normalized;
        chat.lastMessage = latest;
        chat.timestamp = Math.max(chat.timestamp ?? 0, latest.timestamp, normalized.timestamp);
        chat.metadataTimestamp = Math.max(chat.metadataTimestamp ?? 0, latest.timestamp, normalized.timestamp);
        this.applyChatName(chat, latest.fromMe ? undefined : latest.senderName);
        if (inserted && countUnread && !normalized.fromMe) {
            chat.unreadCount = (chat.unreadCount ?? 0) + 1;
        }

        this.queuePersist();
        return normalized;
    }

    private ensureChat(remoteJid: string): LocalChatProjection {
        const jid = stripDeviceSuffix(remoteJid);
        const existing = this.chats.get(jid);
        if (existing) {
            return existing;
        }

        const chat: LocalChatProjection = {
            remoteJid: jid,
            name: contactDisplayName(this.contacts.get(jid), jid),
            unreadCount: 0,
            timestamp: 0,
            metadataTimestamp: 0,
            archived: false,
        };
        this.chats.set(jid, chat);
        return chat;
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
            contactDisplayName(this.contacts.get(jid), jid),
            chat.accountLid ? contactDisplayName(this.contacts.get(stripDeviceSuffix(chat.accountLid)), jid) : undefined,
            chat.lid ? contactDisplayName(this.contacts.get(stripDeviceSuffix(chat.lid)), jid) : undefined,
        ];

        return candidates.find((candidate) => candidate && !isIdentifierLike(candidate)) ?? candidates.find(Boolean) ?? contactDisplayName(undefined, jid);
    }

    private applyChatName(chat: LocalChatProjection, candidate: string | undefined): void {
        if (!candidate) {
            return;
        }

        if (!chat.name || isIdentifierLike(chat.name) || !isIdentifierLike(candidate)) {
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
