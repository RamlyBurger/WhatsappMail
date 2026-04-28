import type {
    ConnectionState,
    ProxyHealth,
    ServerEventPayload,
    WhatsAppChatRow,
    WhatsAppMessage,
    WhatsAppMessageKey,
} from "./types";

interface ChatsResponse {
    chats: WhatsAppChatRow[];
    total: number;
}

interface MessagesResponse {
    messages: WhatsAppMessage[];
    total: number;
}

interface SendMessageResponse {
    message: WhatsAppMessage;
}

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(url, init);
    const data = await response.json().catch(() => null) as unknown;

    if (!response.ok) {
        const message = typeof data === "object" && data && "message" in data
            ? String((data as { message: unknown }).message)
            : `Request failed with ${response.status}`;
        throw new Error(message);
    }

    return data as T;
}

function jsonInit(body?: unknown, method = "POST"): RequestInit {
    return {
        method,
        headers: {
            "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
    };
}

export function getHealth(): Promise<ProxyHealth> {
    return request<ProxyHealth>("/api/health");
}

export async function getConnection(): Promise<ConnectionState> {
    try {
        return await request<ConnectionState>("/api/connection");
    } catch (error) {
        return {
            configured: false,
            state: "error",
            message: error instanceof Error ? error.message : "Connection check failed",
        };
    }
}

export function connectInstance(): Promise<ConnectionState> {
    return request<ConnectionState>("/api/connect", jsonInit());
}

export function requestPairingCode(phoneNumber: string): Promise<ConnectionState> {
    return request<ConnectionState>("/api/pairing-code", jsonInit({ phoneNumber }));
}

export function resetLocalSession(): Promise<ConnectionState> {
    return request<ConnectionState>("/api/logout", jsonInit());
}

export function getChats(params: { q?: string; limit?: number; offset?: number } = {}): Promise<ChatsResponse> {
    const search = new URLSearchParams();
    if (params.q) {
        search.set("q", params.q);
    }
    if (params.limit) {
        search.set("limit", String(params.limit));
    }
    if (params.offset) {
        search.set("offset", String(params.offset));
    }

    const suffix = search.toString() ? `?${search}` : "";
    return request<ChatsResponse>(`/api/chats${suffix}`);
}

export function getMessages(remoteJid: string, page = 1, limit = 50): Promise<MessagesResponse> {
    const search = new URLSearchParams({
        page: String(page),
        limit: String(limit),
    });
    return request<MessagesResponse>(`/api/chats/${encodeURIComponent(remoteJid)}/messages?${search}`);
}

export function sendText(remoteJid: string, text: string, quoted?: unknown): Promise<SendMessageResponse> {
    return request<SendMessageResponse>("/api/messages/text", jsonInit({ remoteJid, text, quoted }));
}

export function sendMedia(remoteJid: string, file: File, caption = "", quoted?: unknown): Promise<SendMessageResponse> {
    const form = new FormData();
    form.set("remoteJid", remoteJid);
    form.set("caption", caption);
    form.set("fileName", file.name);
    form.set("mediatype", mediaTypeFromFile(file));
    if (quoted) {
        form.set("quoted", JSON.stringify(quoted));
    }
    form.set("file", file);

    return request<SendMessageResponse>("/api/messages/media", {
        method: "POST",
        body: form,
    });
}

export function sendReaction(key: WhatsAppMessageKey, reaction: string): Promise<void> {
    return request<void>("/api/messages/reaction", jsonInit({ key, reaction }));
}

export function markChatRead(remoteJid: string, key?: WhatsAppMessageKey): Promise<void> {
    return request<void>(`/api/chats/${encodeURIComponent(remoteJid)}/read`, jsonInit({ key }));
}

export function markChatUnread(remoteJid: string, key?: WhatsAppMessageKey): Promise<void> {
    return request<void>(`/api/chats/${encodeURIComponent(remoteJid)}/unread`, jsonInit({ key }));
}

export function archiveChat(remoteJid: string, key?: WhatsAppMessageKey): Promise<void> {
    return request<void>(`/api/chats/${encodeURIComponent(remoteJid)}/archive`, jsonInit({ key, archive: true }));
}

export function subscribeEvents(onEvent: (payload: ServerEventPayload) => void, onError: () => void): EventSource {
    const source = new EventSource("/events");
    const eventNames = [
        "messages.upsert",
        "messages.update",
        "connection.update",
        "qrcode.updated",
        "local.ready",
    ];

    for (const eventName of eventNames) {
        source.addEventListener(eventName, (event) => {
            onEvent(JSON.parse((event as MessageEvent).data) as ServerEventPayload);
        });
    }

    source.onerror = () => onError();
    return source;
}

type OutgoingMediaType = "image" | "video" | "audio" | "document";

function mediaTypeFromFile(file: File): OutgoingMediaType {
    const mime = file.type.toLowerCase();
    const extension = file.name.split(".").pop()?.toLowerCase() ?? "";

    if (mime.startsWith("image/")) {
        return "image";
    }

    if (mime.startsWith("video/")) {
        return "video";
    }

    if (mime.startsWith("audio/")) {
        return "audio";
    }

    if (["jpg", "jpeg", "png", "gif", "webp", "bmp", "heic", "heif"].includes(extension)) {
        return "image";
    }

    if (["mp4", "m4v", "mov", "webm", "mkv", "avi", "3gp", "3g2", "mpeg", "mpg"].includes(extension)) {
        return "video";
    }

    if (["mp3", "m4a", "aac", "ogg", "oga", "opus", "wav", "flac", "amr"].includes(extension)) {
        return "audio";
    }

    return "document";
}
