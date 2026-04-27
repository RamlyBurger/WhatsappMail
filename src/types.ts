export type RailId = "mail" | "chat" | "meet";
export type FolderId = "inbox" | "starred" | "snoozed" | "sent" | "drafts" | "categories" | "more";
export type MenuId = "status" | "help" | "settings" | "apps" | "profile" | "toolbar" | "keyboard" | "threadMore" | null;
export type SidePanelId = "calendar" | "keep" | "tasks" | "contacts" | "gemini" | null;
export type ComposeMode = "new" | "reply" | "replyAll" | "forward";

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

export interface WhatsAppMessage {
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
}

export interface WhatsAppChatRow {
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
    lastMessage?: WhatsAppMessage;
}

export interface ProxyHealth {
    ok: boolean;
    service?: string;
    mode?: string;
    configured: boolean;
    instanceName: string | null;
    apiUrl: string | null;
    dataDir?: string;
    websocket: {
        globalConnected: boolean;
        instanceConnected: boolean;
    };
    missing: Record<string, boolean>;
}

export interface ConnectionState {
    configured: boolean;
    instanceName?: string;
    state: string;
    message?: string;
    qrcode?: unknown;
    pairingCode?: string | null;
    pairingPhone?: string | null;
    ownerJid?: string | null;
    profileName?: string | null;
    profilePictureUrl?: string | null;
    hasAuthState?: boolean;
}

export interface ComposeState {
    mode: ComposeMode;
    minimized: boolean;
    expanded: boolean;
    remoteJid: string;
    to: string;
    subject: string;
}

export interface AppState {
    activeRail: RailId;
    activeFolder: FolderId;
    openChatId: string | null;
    chats: WhatsAppChatRow[];
    messagesByChat: Record<string, WhatsAppMessage[]>;
    selectedIds: Set<string>;
    starredIds: Set<string>;
    localReadIds: Set<string>;
    archivedIds: Set<string>;
    menu: MenuId;
    status: "Active" | "Do not disturb" | "Away";
    sidePanel: SidePanelId;
    compose: ComposeState | null;
    toast: string | null;
    categoriesExpanded: boolean;
    moreExpanded: boolean;
    sidebarCollapsed: boolean;
    search: string;
    health: ProxyHealth | null;
    connection: ConnectionState | null;
    loadingChats: boolean;
    loadingMessages: boolean;
    error: string | null;
}

export interface ServerEventPayload {
    type: string;
    data: unknown;
}
