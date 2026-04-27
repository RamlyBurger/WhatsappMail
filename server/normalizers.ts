import {
    getContentType,
    normalizeMessageContent,
    type Chat,
    type Contact,
    type proto,
    type WAMessage,
} from "baileys";

export interface WhatsAppMessageKey {
    id: string;
    remoteJid: string;
    fromMe: boolean;
    participant?: string;
}

export interface WhatsAppMediaPreview {
    kind: "image" | "video" | "audio" | "document" | "sticker" | "unknown";
    caption?: string;
    fileName?: string;
    mimetype?: string;
    url?: string;
    seconds?: number;
}

export interface NormalizedMessage {
    id: string;
    remoteJid: string;
    fromMe: boolean;
    senderName: string;
    participant?: string;
    type: string;
    text: string;
    timestamp: number;
    timeLabel: string;
    status?: string;
    key: WhatsAppMessageKey;
    media?: WhatsAppMediaPreview;
    raw?: unknown;
}

export interface NormalizedChat {
    id: string;
    remoteJid: string;
    name: string;
    subject: string;
    snippet: string;
    timestamp: number;
    timeLabel: string;
    unreadCount: number;
    isGroup: boolean;
    isSaved: boolean;
    profilePicUrl?: string;
    lastMessage?: NormalizedMessage;
    raw?: unknown;
}

export interface LocalChatProjection {
    remoteJid: string;
    name?: string;
    unreadCount?: number;
    timestamp?: number;
    metadataTimestamp?: number;
    archived?: boolean;
    profilePicUrl?: string;
    lastMessage?: NormalizedMessage;
    raw?: unknown;
}

type MessageContent = NonNullable<WAMessage["message"]>;
type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord {
    return typeof value === "object" && value !== null ? value as UnknownRecord : {};
}

function asString(value: unknown, fallback = ""): string {
    return typeof value === "string" ? value : fallback;
}

function optionalString(value: unknown): string | undefined {
    return typeof value === "string" && value ? value : undefined;
}

function asNumber(value: unknown, fallback = 0): number {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }

    if (typeof value === "string") {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    }

    if (typeof value === "object" && value !== null && "toNumber" in value && typeof value.toNumber === "function") {
        const parsed = Number(value.toNumber());
        return Number.isFinite(parsed) ? parsed : fallback;
    }

    return fallback;
}

export function stripDeviceSuffix(jid: string): string {
    if (!jid) {
        return "";
    }

    const [user, domain] = jid.split("@");
    return domain ? `${user.split(":")[0]}@${domain}` : jid;
}

export function normalizeInputJid(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) {
        return "";
    }

    if (trimmed.includes("@")) {
        return stripDeviceSuffix(trimmed);
    }

    const digits = trimmed.replace(/[^\d]/g, "");
    return digits ? `${digits}@s.whatsapp.net` : trimmed;
}

export function jidToDisplayName(remoteJid: string): string {
    if (!remoteJid) {
        return "Unknown chat";
    }

    if (remoteJid === "status@broadcast") {
        return "Status";
    }

    const base = remoteJid.split("@")[0].split(":")[0];
    if (!base) {
        return remoteJid;
    }

    if (remoteJid.endsWith("@g.us")) {
        return base;
    }

    return base.replace(/^(\d{1,3})(\d{3,})(\d{4})$/, "+$1 $2 $3");
}

export function isIdentifierLike(value: string | undefined | null): boolean {
    const text = String(value ?? "").trim();
    if (!text) {
        return true;
    }

    return text.endsWith("@s.whatsapp.net")
        || text.endsWith("@lid")
        || /^\+?\d[\d\s().-]{6,}$/.test(text);
}

export function formatTimeLabel(timestamp: number): string {
    if (!timestamp) {
        return "";
    }

    const date = new Date(timestamp * 1000);
    const now = new Date();
    const sameDay = date.toDateString() === now.toDateString();

    if (sameDay) {
        return new Intl.DateTimeFormat("en-US", {
            hour: "numeric",
            minute: "2-digit",
        }).format(date);
    }

    const sameYear = date.getFullYear() === now.getFullYear();
    return new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        ...(sameYear ? {} : { year: "numeric" }),
    }).format(date);
}

export function timestampSeconds(value: WAMessage["messageTimestamp"] | Chat["conversationTimestamp"] | number | undefined): number {
    const numeric = asNumber(value, 0);
    return numeric > 10_000_000_000 ? Math.floor(numeric / 1000) : numeric;
}

export function contactDisplayName(contact: Partial<Contact> | undefined, fallbackJid: string): string {
    const record = asRecord(contact);
    return asString(record.name || record.verifiedName || record.notify || record.pushName, jidToDisplayName(fallbackJid));
}

function contentRecord(value: unknown): UnknownRecord {
    return typeof value === "string" ? { text: value } : asRecord(value);
}

function extractMessageText(contentType: string, content: UnknownRecord): { text: string; subject: string; media?: WhatsAppMediaPreview } {
    if (contentType === "conversation" || contentType === "extendedTextMessage") {
        const text = asString(content.text || content.conversation);
        return { text, subject: "Text message" };
    }

    if (contentType === "imageMessage") {
        const caption = asString(content.caption);
        return {
            text: caption || "Image message",
            subject: "Image",
            media: {
                kind: "image",
                caption,
                mimetype: optionalString(content.mimetype),
                url: optionalString(content.url),
            },
        };
    }

    if (contentType === "videoMessage") {
        const caption = asString(content.caption);
        return {
            text: caption || "Video message",
            subject: "Video",
            media: {
                kind: "video",
                caption,
                mimetype: optionalString(content.mimetype),
                url: optionalString(content.url),
            },
        };
    }

    if (contentType === "audioMessage") {
        return {
            text: content.ptt ? "Voice message" : "Audio message",
            subject: content.ptt ? "Voice note" : "Audio",
            media: {
                kind: "audio",
                mimetype: optionalString(content.mimetype),
                seconds: asNumber(content.seconds),
                url: optionalString(content.url),
            },
        };
    }

    if (contentType === "documentMessage") {
        const caption = asString(content.caption);
        const fileName = asString(content.fileName);
        return {
            text: caption || fileName || "Document message",
            subject: "Document",
            media: {
                kind: "document",
                caption,
                fileName,
                mimetype: optionalString(content.mimetype),
                url: optionalString(content.url),
            },
        };
    }

    if (contentType === "stickerMessage") {
        return {
            text: "Sticker",
            subject: "Sticker",
            media: {
                kind: "sticker",
                mimetype: optionalString(content.mimetype),
                url: optionalString(content.url),
            },
        };
    }

    if (contentType === "reactionMessage") {
        return {
            text: asString(content.text, "Reaction"),
            subject: "Reaction",
        };
    }

    if (contentType === "locationMessage") {
        return { text: "Location", subject: "Location" };
    }

    if (contentType === "contactMessage" || contentType === "contactsArrayMessage") {
        return { text: "Contact card", subject: "Contact" };
    }

    const label = contentType ? contentType.replace(/Message$/i, "") : "Message";
    return {
        text: label,
        subject: label,
    };
}

export function normalizeWAMessage(raw: WAMessage, ownerJid = ""): NormalizedMessage | null {
    const remoteJid = stripDeviceSuffix(raw.key.remoteJid ?? "");
    const id = raw.key.id ?? "";
    if (!remoteJid || !id || remoteJid === "status@broadcast") {
        return null;
    }

    const normalizedContent = normalizeMessageContent(raw.message ?? undefined) as MessageContent | undefined;
    const contentType = getContentType(normalizedContent);
    if (!contentType || contentType === "protocolMessage") {
        return null;
    }

    const content = contentRecord(normalizedContent?.[contentType as keyof MessageContent]);
    const extracted = extractMessageText(contentType, content);
    const timestamp = timestampSeconds(raw.messageTimestamp);
    const participant = raw.key.participant ? stripDeviceSuffix(raw.key.participant) : undefined;
    const fromMe = Boolean(raw.key.fromMe);
    const senderJid = fromMe ? ownerJid : participant ?? remoteJid;
    const senderName = fromMe ? "me" : raw.pushName ?? jidToDisplayName(senderJid);

    return {
        id,
        remoteJid,
        fromMe,
        senderName,
        participant,
        type: extracted.subject,
        text: extracted.text,
        timestamp,
        timeLabel: formatTimeLabel(timestamp),
        status: raw.status === undefined ? undefined : String(raw.status),
        key: {
            id,
            remoteJid,
            fromMe,
            participant,
        },
        media: extracted.media,
        raw,
    };
}

export function normalizeLocalChat(chat: LocalChatProjection): NormalizedChat {
    const remoteJid = stripDeviceSuffix(chat.remoteJid);
    const isGroup = remoteJid.endsWith("@g.us");
    const name = chat.name || jidToDisplayName(remoteJid);
    const lastMessage = chat.lastMessage;
    const messageTimestamp = lastMessage?.timestamp ?? 0;
    const metadataTimestamp = chat.metadataTimestamp ?? chat.timestamp ?? 0;
    const hasNewerMetadata = Boolean(lastMessage && metadataTimestamp > messageTimestamp + 60);
    const timestamp = metadataTimestamp || messageTimestamp;

    return {
        id: remoteJid,
        remoteJid,
        name,
        subject: hasNewerMetadata
            ? "Syncing latest message"
            : lastMessage?.fromMe
              ? `You: ${lastMessage.type}`
              : lastMessage?.type || (isGroup ? "Group chat" : "Chat"),
        snippet: hasNewerMetadata ? "Latest WhatsApp message is still loading" : lastMessage?.text || "No recent messages",
        timestamp,
        timeLabel: formatTimeLabel(timestamp),
        unreadCount: Math.max(0, chat.unreadCount ?? 0),
        isGroup,
        isSaved: Boolean(chat.raw),
        profilePicUrl: chat.profilePicUrl,
        lastMessage,
        raw: chat.raw,
    };
}

export function keySignature(key: WhatsAppMessageKey): string {
    return `${stripDeviceSuffix(key.remoteJid)}:${key.id}`;
}

export function protoKeyFromNormalized(key: WhatsAppMessageKey): proto.IMessageKey {
    return {
        id: key.id,
        remoteJid: stripDeviceSuffix(key.remoteJid),
        fromMe: key.fromMe,
        participant: key.participant,
    };
}
