import {
    getContentType,
    normalizeMessageContent,
    WAMessageStubType,
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
    activityOnly?: boolean;
    bumpChat?: boolean;
    raw?: unknown;
}

export interface NormalizedChat {
    id: string;
    remoteJid: string;
    name: string;
    subject: string;
    snippet: string;
    timestamp: number;
    sortTimestamp: number;
    timeLabel: string;
    unreadCount: number;
    isGroup: boolean;
    isSaved: boolean;
    isPinned?: boolean;
    pinnedTimestamp?: number;
    pinnedRank?: number;
    profilePicUrl?: string;
    lastMessage?: NormalizedMessage;
    lastActivity?: NormalizedMessage;
    raw?: unknown;
}

export interface LocalChatProjection {
    remoteJid: string;
    name?: string;
    unreadCount?: number;
    timestamp?: number;
    metadataTimestamp?: number;
    archived?: boolean;
    pinned?: boolean;
    pinnedTimestamp?: number;
    pinnedRank?: number;
    profilePicUrl?: string;
    lastMessage?: NormalizedMessage;
    lastActivity?: NormalizedMessage;
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

    if (remoteJid.endsWith("@lid")) {
        return "WhatsApp user";
    }

    return /^\d+$/.test(base) ? `+${base}` : base;
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

export function timestampSeconds(value: unknown): number {
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

function withActivityBumpState<T extends NormalizedMessage>(message: T): T {
    if (message.activityOnly && message.type === "Group activity" && message.bumpChat !== false) {
        return {
            ...message,
            bumpChat: false,
        } as T;
    }

    return message;
}

export function contactDisplayName(contact: Partial<Contact> | undefined, fallbackJid: string): string {
    const record = asRecord(contact);
    const phoneNumber = asString(record.phoneNumber);
    return asString(record.name || record.verifiedName || record.notify || record.pushName, phoneNumber ? jidToDisplayName(phoneNumber) : jidToDisplayName(fallbackJid));
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
        const label = asString(content.name || content.address);
        return { text: label || "Location", subject: "Location" };
    }

    if (contentType === "liveLocationMessage") {
        const label = asString(content.caption || content.name || content.address);
        return { text: label || "Live location", subject: "Live location" };
    }

    if (contentType === "contactMessage" || contentType === "contactsArrayMessage") {
        const displayName = asString(content.displayName);
        const contacts = Array.isArray(content.contacts) ? content.contacts.length : 0;
        return { text: displayName || (contacts > 1 ? `${contacts} contacts` : "Contact card"), subject: "Contact" };
    }

    if (contentType === "groupInviteMessage") {
        const groupName = asString(content.groupName);
        return { text: groupName || "Group invite", subject: "Group invite" };
    }

    if (
        contentType === "pollCreationMessage"
        || contentType === "pollCreationMessageV2"
        || contentType === "pollCreationMessageV3"
        || contentType === "pollCreationMessageV5"
    ) {
        const pollName = asString(content.name);
        return { text: pollName || "Poll", subject: "Poll" };
    }

    if (contentType === "eventMessage") {
        const eventName = asString(content.name || content.description);
        return { text: eventName || "Event", subject: "Event" };
    }

    if (contentType === "buttonsMessage" || contentType === "listMessage" || contentType === "templateMessage") {
        const text = asString(content.text || content.contentText || content.title || content.caption || content.footer);
        return { text: text || "Interactive message", subject: "Interactive message" };
    }

    if (contentType === "productMessage") {
        const product = asRecord(content.product);
        const title = asString(product.title || content.title);
        return { text: title || "Product", subject: "Product" };
    }

    if (contentType === "orderMessage") {
        return { text: "Order", subject: "Order" };
    }

    if (contentType === "protocolMessage") {
        return { text: "Message update", subject: "Message update" };
    }

    const label = contentType ? contentType.replace(/Message$/i, "") : "Message";
    return {
        text: label,
        subject: label,
    };
}

function stubParameterName(value: string | undefined): string {
    if (!value) {
        return "someone";
    }

    if (!value.includes("@")) {
        return "a participant";
    }

    const jid = stripDeviceSuffix(value);
    if (jid.endsWith("@lid")) {
        return "WhatsApp user";
    }

    return jidToDisplayName(jid || value);
}

function formatStubNameList(values: string[]): string {
    const names = values.map(stubParameterName).filter(Boolean);
    if (!names.length) {
        return "someone";
    }

    if (names.length <= 2) {
        return names.join(" and ");
    }

    return `${names.slice(0, 2).join(", ")} and ${names.length - 2} others`;
}

function normalizeStubMessage(raw: WAMessage, ownerJid = ""): NormalizedMessage | null {
    const remoteJid = stripDeviceSuffix(raw.key.remoteJid ?? "");
    const id = raw.key.id ?? "";
    const stubType = raw.messageStubType;
    if (!remoteJid || !id || stubType === undefined || stubType === null || remoteJid === "status@broadcast") {
        return null;
    }

    const timestamp = timestampSeconds(raw.messageTimestamp);
    const participantFromEnvelope = optionalString(asRecord(raw).participant);
    const participant = raw.key.participant
        ? stripDeviceSuffix(raw.key.participant)
        : participantFromEnvelope
          ? stripDeviceSuffix(participantFromEnvelope)
          : undefined;
    const normalizedOwner = stripDeviceSuffix(ownerJid);
    const senderJid = participant ?? "";
    const fromMe = Boolean(normalizedOwner && senderJid === normalizedOwner);
    const senderName = fromMe ? "me" : raw.pushName ?? (senderJid ? jidToDisplayName(senderJid) : "Someone");
    const actor = fromMe ? "You" : senderName;
    const parameters = raw.messageStubParameters ?? [];
    const targets = formatStubNameList(parameters);

    let type = "Group activity";
    let text = "Group activity";
    let activityOnly = true;
    let bumpChat = false;

    switch (stubType) {
        case WAMessageStubType.GROUP_CREATE:
            text = `${actor} created the group`;
            break;
        case WAMessageStubType.GROUP_CHANGE_SUBJECT:
            text = `${actor} changed the group name${parameters[0] ? ` to "${parameters[0]}"` : ""}`;
            break;
        case WAMessageStubType.GROUP_CHANGE_ICON:
            text = `${actor} changed the group icon`;
            break;
        case WAMessageStubType.GROUP_CHANGE_INVITE_LINK:
            text = `${actor} reset the group invite link`;
            break;
        case WAMessageStubType.GROUP_CHANGE_DESCRIPTION:
            text = `${actor} changed the group description`;
            break;
        case WAMessageStubType.GROUP_CHANGE_RESTRICT:
        case WAMessageStubType.GROUP_CHANGE_ANNOUNCE:
            text = `${actor} changed the group settings`;
            break;
        case WAMessageStubType.GROUP_PARTICIPANT_ADD:
        case WAMessageStubType.GROUP_PARTICIPANT_INVITE:
            text = `${actor} added ${targets}`;
            bumpChat = false;
            break;
        case WAMessageStubType.GROUP_PARTICIPANT_REMOVE:
            text = `${actor} removed ${targets}`;
            bumpChat = false;
            break;
        case WAMessageStubType.GROUP_PARTICIPANT_LEAVE:
            text = `${targets} left`;
            bumpChat = false;
            break;
        case WAMessageStubType.GROUP_PARTICIPANT_PROMOTE:
            text = `${actor} made ${targets} ${parameters.length === 1 ? "an admin" : "admins"}`;
            bumpChat = false;
            break;
        case WAMessageStubType.GROUP_PARTICIPANT_DEMOTE:
            text = `${actor} dismissed ${targets} as ${parameters.length === 1 ? "admin" : "admins"}`;
            bumpChat = false;
            break;
        case WAMessageStubType.GROUP_PARTICIPANT_CHANGE_NUMBER:
            text = `${parameters[0] ? stubParameterName(parameters[0]) : "Someone"} changed their phone number`;
            bumpChat = false;
            break;
        case WAMessageStubType.GROUP_PARTICIPANT_ACCEPT:
        case WAMessageStubType.GROUP_PARTICIPANT_LINKED_GROUP_JOIN:
        case WAMessageStubType.GROUP_PARTICIPANT_JOINED_GROUP_AND_PARENT_GROUP:
            text = `${targets} joined`;
            bumpChat = false;
            break;
        case WAMessageStubType.CALL_MISSED_VIDEO:
        case WAMessageStubType.CALL_MISSED_GROUP_VIDEO:
            type = "Video call";
            text = "Missed video call";
            bumpChat = true;
            break;
        case WAMessageStubType.CALL_MISSED_VOICE:
        case WAMessageStubType.CALL_MISSED_GROUP_VOICE:
            type = "Voice call";
            text = "Missed voice call";
            bumpChat = true;
            break;
        case WAMessageStubType.REVOKE:
        case WAMessageStubType.ADMIN_REVOKE:
            type = "Deleted message";
            text = fromMe ? "You deleted this message" : "This message was deleted";
            activityOnly = false;
            bumpChat = true;
            break;
        default:
            if (!remoteJid.endsWith("@g.us")) {
                return null;
            }
            text = "Group activity";
            break;
    }

    return {
        id,
        remoteJid,
        fromMe,
        senderName,
        participant,
        type,
        text,
        timestamp,
        timeLabel: formatTimeLabel(timestamp),
        key: {
            id,
            remoteJid,
            fromMe,
            participant,
        },
        activityOnly,
        bumpChat,
        raw,
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
        return normalizeStubMessage(raw, ownerJid);
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

export function createMetadataActivityMessage(chat: LocalChatProjection): NormalizedMessage | undefined {
    const remoteJid = stripDeviceSuffix(chat.remoteJid);
    const metadataTimestamp = chat.metadataTimestamp ?? 0;
    const lastTimestamp = Math.max(chat.lastMessage?.timestamp ?? 0, chat.lastActivity?.timestamp ?? 0);
    if (!remoteJid || metadataTimestamp <= lastTimestamp) {
        return undefined;
    }

    const isGroup = remoteJid.endsWith("@g.us");
    const type = isGroup ? "Recent activity" : "Voice call";
    const senderName = isGroup ? "Someone" : chat.name || jidToDisplayName(remoteJid);

    return {
        id: `activity:${remoteJid}:${metadataTimestamp}`,
        remoteJid,
        fromMe: false,
        senderName,
        type,
        text: type,
        timestamp: metadataTimestamp,
        timeLabel: formatTimeLabel(metadataTimestamp),
        key: {
            id: `activity:${metadataTimestamp}`,
            remoteJid,
            fromMe: false,
        },
        activityOnly: true,
        bumpChat: !isGroup,
    };
}

export function normalizeLocalChat(chat: LocalChatProjection): NormalizedChat {
    const remoteJid = stripDeviceSuffix(chat.remoteJid);
    const isGroup = remoteJid.endsWith("@g.us");
    const name = chat.name || jidToDisplayName(remoteJid);
    const lastMessage = chat.lastMessage ? withActivityBumpState(withMessageReceipt(chat.lastMessage)) : undefined;
    const metadataTimestamp = chat.metadataTimestamp ?? chat.timestamp ?? 0;
    const persistedActivity = chat.lastActivity ? withActivityBumpState(withMessageReceipt(chat.lastActivity)) : undefined;
    const metadataActivity = createMetadataActivityMessage({
        ...chat,
        remoteJid,
        name,
        lastMessage,
        lastActivity: persistedActivity,
        metadataTimestamp,
    });
    const activities = [persistedActivity, metadataActivity, lastMessage]
        .filter((activity): activity is NormalizedMessage => Boolean(activity))
        .sort((a, b) => b.timestamp - a.timestamp);
    const lastActivity = activities[0];
    const timestamp = lastActivity?.timestamp ?? metadataTimestamp;
    const latestBumpingActivity = activities.find((activity) => activity.bumpChat !== false);
    const sortTimestamp = latestBumpingActivity?.timestamp
        ?? (lastActivity?.bumpChat === false ? 0 : metadataTimestamp);
    const rawSenderName = lastActivity?.fromMe ? "You" : lastActivity?.senderName;
    const senderName = rawSenderName && !isIdentifierLike(rawSenderName) ? rawSenderName : "Someone";
    const groupPreview = Boolean(isGroup && lastActivity);
    const activityPreview = Boolean(lastActivity?.activityOnly);
    const isTextMessage = lastActivity?.type === "Text message";
    const messageText = lastActivity?.text.trim() ?? "";
    const repeatedMediaText = Boolean(lastActivity && messageText === lastActivity.type);
    const subject = groupPreview && activityPreview
        ? messageText || lastActivity?.type || "Recent activity"
        : groupPreview
        ? `${senderName || "Someone"}:`
        : lastActivity?.fromMe
          ? isTextMessage
            ? "You:"
            : `You: ${lastActivity.type}`
          : isTextMessage
            ? messageText || "Text message"
            : lastActivity?.type || (isGroup ? "Group chat" : "Chat");
    const snippet = groupPreview && activityPreview
        ? ""
        : groupPreview
        ? messageText || lastActivity?.type || ""
        : isTextMessage
          ? lastActivity?.fromMe ? messageText : ""
          : repeatedMediaText ? "" : messageText || "No recent messages";

    return {
        id: remoteJid,
        remoteJid,
        name,
        subject,
        snippet,
        timestamp,
        sortTimestamp,
        timeLabel: formatTimeLabel(timestamp),
        unreadCount: Math.max(0, chat.unreadCount ?? 0),
        isGroup,
        isSaved: Boolean(chat.raw),
        isPinned: Boolean(chat.pinned),
        pinnedTimestamp: chat.pinnedTimestamp,
        pinnedRank: chat.pinnedRank,
        profilePicUrl: chat.profilePicUrl,
        lastMessage,
        lastActivity,
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
