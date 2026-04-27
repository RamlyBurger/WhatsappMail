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

export type WhatsAppReceiptState = "error" | "pending" | "sent" | "delivered" | "read" | "played";

export interface WhatsAppReadReceipt {
    state: WhatsAppReceiptState;
    label: string;
    code?: string;
    deliveredCount?: number;
    readCount?: number;
    playedCount?: number;
}

export interface WhatsAppReaction {
    text: string;
    senderJid?: string;
    senderName?: string;
    fromMe?: boolean;
    timestamp?: number;
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
    receipt?: WhatsAppReadReceipt;
    key: WhatsAppMessageKey;
    media?: WhatsAppMediaPreview;
    reactions?: WhatsAppReaction[];
    forwarded?: boolean;
    forwardingScore?: number;
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

    return text === "*"
        || text.endsWith("@s.whatsapp.net")
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

function receiptStateFromStatus(value: unknown): WhatsAppReadReceipt | undefined {
    const normalized = String(value ?? "").trim().toUpperCase();
    if (!normalized || normalized === "NULL" || normalized === "UNDEFINED") {
        return undefined;
    }

    const statusMap: Record<string, WhatsAppReadReceipt> = {
        "0": { state: "error", label: "Failed", code: "ERROR" },
        ERROR: { state: "error", label: "Failed", code: "ERROR" },
        "1": { state: "pending", label: "Pending", code: "PENDING" },
        PENDING: { state: "pending", label: "Pending", code: "PENDING" },
        "2": { state: "sent", label: "Sent", code: "SERVER_ACK" },
        SERVER_ACK: { state: "sent", label: "Sent", code: "SERVER_ACK" },
        "3": { state: "delivered", label: "Delivered", code: "DELIVERY_ACK" },
        DELIVERY_ACK: { state: "delivered", label: "Delivered", code: "DELIVERY_ACK" },
        "4": { state: "read", label: "Read", code: "READ" },
        READ: { state: "read", label: "Read", code: "READ" },
        "5": { state: "played", label: "Played", code: "PLAYED" },
        PLAYED: { state: "played", label: "Played", code: "PLAYED" },
    };

    return statusMap[normalized];
}

function receiptStatsFromRaw(raw: unknown): Pick<WhatsAppReadReceipt, "deliveredCount" | "readCount" | "playedCount"> {
    const userReceipt = asRecord(raw).userReceipt;
    if (!Array.isArray(userReceipt)) {
        return {};
    }

    let deliveredCount = 0;
    let readCount = 0;
    let playedCount = 0;
    for (const receipt of userReceipt) {
        const record = asRecord(receipt);
        if (asNumber(record.receiptTimestamp) > 0) {
            deliveredCount += 1;
        }
        if (asNumber(record.readTimestamp) > 0) {
            readCount += 1;
        }
        if (asNumber(record.playedTimestamp) > 0) {
            playedCount += 1;
        }
    }

    return {
        ...(deliveredCount ? { deliveredCount } : {}),
        ...(readCount ? { readCount } : {}),
        ...(playedCount ? { playedCount } : {}),
    };
}

function receiptDetail(receipt: WhatsAppReadReceipt): string {
    const details = [
        receipt.deliveredCount ? `delivered to ${receipt.deliveredCount}` : "",
        receipt.readCount ? `read by ${receipt.readCount}` : "",
        receipt.playedCount ? `played by ${receipt.playedCount}` : "",
    ].filter(Boolean);

    return details.length ? `${receipt.label} (${details.join(", ")})` : receipt.label;
}

export function normalizeMessageReceipt(status: unknown, raw: unknown, fromMe: boolean, remoteJid: string): WhatsAppReadReceipt | undefined {
    if (!fromMe) {
        return undefined;
    }

    const base = receiptStateFromStatus(status);
    const stats = receiptStatsFromRaw(raw);
    const isGroup = stripDeviceSuffix(remoteJid).endsWith("@g.us");
    const receipt = { ...(base ?? { state: "sent" as const, label: "Sent", code: "SERVER_ACK" }), ...stats };

    if (!isGroup) {
        if (receipt.playedCount) {
            receipt.state = "played";
            receipt.label = "Played";
            receipt.code = "PLAYED";
        } else if (receipt.readCount) {
            receipt.state = "read";
            receipt.label = "Read";
            receipt.code = "READ";
        } else if (receipt.deliveredCount && receipt.state !== "read" && receipt.state !== "played") {
            receipt.state = "delivered";
            receipt.label = "Delivered";
            receipt.code = "DELIVERY_ACK";
        }
    }

    return {
        ...receipt,
        label: receiptDetail(receipt),
    };
}

export function withMessageReceipt<T extends NormalizedMessage>(message: T): T {
    return {
        ...message,
        status: message.status && message.status !== "null" ? message.status : undefined,
        receipt: message.receipt ?? normalizeMessageReceipt(message.status, message.raw, message.fromMe, message.remoteJid),
    };
}

export function contactDisplayName(contact: Partial<Contact> | undefined, fallbackJid: string): string {
    const record = asRecord(contact);
    return asString(record.name || record.verifiedName || record.notify || record.pushName, jidToDisplayName(fallbackJid));
}

export function contactSavedName(contact: Partial<Contact> | undefined): string | undefined {
    const name = asString(asRecord(contact).name).trim();
    return name && !isIdentifierLike(name) ? name : undefined;
}

function contentRecord(value: unknown): UnknownRecord {
    return typeof value === "string" ? { text: value } : asRecord(value);
}

function normalizeTimestampMs(value: unknown): number | undefined {
    const timestamp = asNumber(value, 0);
    if (!timestamp) {
        return undefined;
    }

    return timestamp > 10_000_000_000 ? Math.floor(timestamp / 1000) : timestamp;
}

function extractForwardInfo(content: UnknownRecord): Pick<NormalizedMessage, "forwarded" | "forwardingScore"> {
    const context = asRecord(content.contextInfo);
    const forwardingScore = asNumber(context.forwardingScore, 0);
    const forwarded = Boolean(context.isForwarded) || forwardingScore > 0;

    return forwarded
        ? {
            forwarded: true,
            ...(forwardingScore ? { forwardingScore } : {}),
        }
        : {};
}

export function normalizeMessageReaction(reaction: proto.IReaction, ownerJid = "", remoteJid = ""): WhatsAppReaction | null {
    const text = asString(reaction.text).trim();
    if (!text) {
        return null;
    }

    const key = reaction.key ?? {};
    const senderJid = stripDeviceSuffix(
        optionalString(key.participant) ?? optionalString(key.remoteJid) ?? "",
    );
    const normalizedOwner = stripDeviceSuffix(ownerJid);
    const normalizedRemote = stripDeviceSuffix(remoteJid);
    const fromMe = Boolean(key.fromMe)
        || Boolean(normalizedOwner && senderJid === normalizedOwner)
        || Boolean(key.fromMe && senderJid === normalizedRemote);
    const timestamp = normalizeTimestampMs(reaction.senderTimestampMs);

    return {
        text,
        ...(senderJid ? { senderJid } : {}),
        ...(fromMe ? { fromMe } : {}),
        ...(timestamp ? { timestamp } : {}),
    };
}

export function normalizeMessageReactions(reactions: unknown, ownerJid = "", remoteJid = ""): WhatsAppReaction[] | undefined {
    if (!Array.isArray(reactions)) {
        return undefined;
    }

    const normalized = reactions
        .map((reaction) => normalizeMessageReaction(reaction as proto.IReaction, ownerJid, remoteJid))
        .filter((reaction): reaction is WhatsAppReaction => Boolean(reaction));

    return normalized.length ? normalized : undefined;
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

    if (contentType === "callLogMessage" || contentType === "callLogMesssage") {
        const isVideo = Boolean(content.isVideo);
        const subject = isVideo ? "Video call" : "Voice call";
        const outcome = asString(content.callOutcome).toLowerCase();
        const text = outcome && outcome !== "0" ? `${subject} (${outcome})` : subject;
        return { text, subject };
    }

    if (contentType === "scheduledCallCreationMessage" || contentType === "scheduledCallEditMessage") {
        return { text: "Scheduled call", subject: "Scheduled call" };
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
    const forwardInfo = extractForwardInfo(content);
    const timestamp = timestampSeconds(raw.messageTimestamp);
    const participantFromEnvelope = optionalString(asRecord(raw).participant);
    const participant = raw.key.participant
        ? stripDeviceSuffix(raw.key.participant)
        : participantFromEnvelope
          ? stripDeviceSuffix(participantFromEnvelope)
          : undefined;
    const fromMe = Boolean(raw.key.fromMe);
    const senderJid = fromMe ? ownerJid : participant ?? remoteJid;
    const senderName = fromMe ? "me" : raw.pushName ?? jidToDisplayName(senderJid);
    const status = raw.status === undefined || raw.status === null ? undefined : String(raw.status);

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
        status,
        receipt: normalizeMessageReceipt(status, raw, fromMe, remoteJid),
        key: {
            id,
            remoteJid,
            fromMe,
            participant,
        },
        media: extracted.media,
        reactions: normalizeMessageReactions(asRecord(raw).reactions, ownerJid, remoteJid),
        ...forwardInfo,
        raw,
    };
}

export function normalizeLocalChat(chat: LocalChatProjection): NormalizedChat {
    const remoteJid = stripDeviceSuffix(chat.remoteJid);
    const isGroup = remoteJid.endsWith("@g.us");
    const name = chat.name || jidToDisplayName(remoteJid);
    const lastMessage = chat.lastMessage ? withMessageReceipt(chat.lastMessage) : undefined;
    const messageTimestamp = lastMessage?.timestamp ?? 0;
    const metadataTimestamp = chat.metadataTimestamp ?? chat.timestamp ?? 0;
    const timestamp = lastMessage ? messageTimestamp : metadataTimestamp;
    const rawSenderName = lastMessage?.fromMe ? "You" : lastMessage?.senderName;
    const senderName = rawSenderName && !isIdentifierLike(rawSenderName) ? rawSenderName : "Someone";
    const groupPreview = Boolean(isGroup && lastMessage);
    const isTextMessage = lastMessage?.type === "Text message";
    const messageText = lastMessage?.text.trim() ?? "";
    const repeatedMediaText = Boolean(lastMessage && messageText === lastMessage.type);
    const subject = groupPreview
        ? `${senderName || "Someone"}:`
        : lastMessage?.fromMe
          ? isTextMessage
            ? "You:"
            : `You: ${lastMessage.type}`
          : isTextMessage
            ? messageText || "Text message"
            : lastMessage?.type || (isGroup ? "Group chat" : "Chat");
    const snippet = groupPreview
        ? messageText || lastMessage?.type || ""
        : isTextMessage
          ? lastMessage?.fromMe ? messageText : ""
          : repeatedMediaText ? "" : messageText || "No recent messages";

    return {
        id: remoteJid,
        remoteJid,
        name,
        subject,
        snippet,
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
