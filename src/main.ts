import {
    archiveChat,
    connectInstance,
    getChats,
    getConnection,
    getHealth,
    getMessages,
    markChatRead,
    markChatUnread,
    requestPairingCode,
    resetLocalSession,
    sendMedia,
    sendReaction,
    sendText,
    subscribeEvents,
} from "./api";
import type {
    AppState,
    ComposeMode,
    ConnectionState,
    FolderId,
    RailId,
    ServerEventPayload,
    SidePanelId,
    WhatsAppChatRow,
    WhatsAppMessage,
    WhatsAppMessageKey,
} from "./types";

const appRoot = document.getElementById("app");
let toastTimer: number | undefined;
let events: EventSource | null = null;
let pendingThreadScrollBottom = false;
const CLIENT_CACHE_KEY = "whatsappmail.clientCache.v1";

if (!appRoot) {
    throw new Error("Missing #app root");
}

const app = appRoot;

const state: AppState = {
    activeRail: "mail",
    activeFolder: "inbox",
    openChatId: window.location.hash === "#open-chat" ? "" : null,
    chats: [],
    messagesByChat: {},
    selectedIds: new Set<string>(),
    starredIds: new Set<string>(),
    localReadIds: new Set<string>(),
    archivedIds: new Set<string>(),
    menu: null,
    status: "Active",
    sidePanel: null,
    compose: null,
    toast: null,
    categoriesExpanded: true,
    moreExpanded: true,
    sidebarCollapsed: false,
    search: "",
    health: null,
    connection: null,
    loadingChats: true,
    loadingMessages: false,
    error: null,
};

interface ClientCache {
    chats: WhatsAppChatRow[];
    messagesByChat: Record<string, WhatsAppMessage[]>;
    starredIds: string[];
    localReadIds: string[];
    archivedIds: string[];
    savedAt: number;
}

interface LoadOptions {
    showLoading?: boolean;
    scrollToBottom?: boolean;
}

function icon(name: string, fill = false): string {
    return `<span class="material-symbols-outlined${fill ? " fill" : ""}">${name}</span>`;
}

function selectedClass(value: boolean): string {
    return value ? " active" : "";
}

function escapeHtml(value: unknown): string {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function currentChat(): WhatsAppChatRow | null {
    return state.chats.find((chat) => chat.remoteJid === state.openChatId) ?? null;
}

function currentMessages(): WhatsAppMessage[] {
    return state.openChatId ? state.messagesByChat[state.openChatId] ?? [] : [];
}

function isUnread(chat: WhatsAppChatRow): boolean {
    return chat.unreadCount > 0 && !state.localReadIds.has(chat.remoteJid);
}

function visibleChats(): WhatsAppChatRow[] {
    let rows = state.chats.filter((chat) => !state.archivedIds.has(chat.remoteJid));

    switch (state.activeFolder) {
        case "starred":
            rows = rows.filter((chat) => state.starredIds.has(chat.remoteJid));
            break;
        case "sent":
            rows = rows.filter((chat) => chat.lastMessage?.fromMe);
            break;
        case "drafts":
        case "snoozed":
            rows = [];
            break;
        case "categories":
            rows = rows.filter((chat) => chat.isGroup);
            break;
        case "more":
        case "inbox":
            break;
        default:
            break;
    }

    const search = state.search.trim().toLowerCase();
    if (search) {
        rows = rows.filter((chat) => `${chat.name} ${chat.subject} ${chat.snippet}`.toLowerCase().includes(search));
    }

    return rows.sort((a, b) => b.timestamp - a.timestamp);
}

function totalUnread(): number {
    return state.chats.reduce((total, chat) => total + (isUnread(chat) ? chat.unreadCount : 0), 0);
}

function renderRail(): string {
    const rails: Array<{ id: RailId; icon: string; label: string; badge?: string }> = [
        { id: "mail", icon: "mail", label: "Mail", badge: totalUnread() ? "99+" : undefined },
        { id: "chat", icon: "chat_bubble", label: "Chat" },
        { id: "meet", icon: "videocam", label: "Meet" },
    ];

    return `
        <aside class="rail">
            <button class="icon-button hamburger" aria-label="${state.sidebarCollapsed ? "Expand main menu" : "Collapse main menu"}" aria-expanded="${state.sidebarCollapsed ? "false" : "true"}" data-action="toggle-sidebar">${icon("menu")}</button>
            <nav class="rail-nav" aria-label="Google apps">
                ${rails.map((rail) => `
                    <button class="rail-item${selectedClass(state.activeRail === rail.id)}" data-action="set-rail" data-rail="${rail.id}">
                        <span class="rail-icon">
                            ${icon(rail.icon, state.activeRail === rail.id)}
                            ${rail.badge ? `<span class="rail-badge">${rail.badge}</span>` : ""}
                        </span>
                        <span>${rail.label}</span>
                    </button>
                `).join("")}
            </nav>
        </aside>
    `;
}

function renderTopBar(): string {
    return `
        <header class="brand-bar">
            <img class="gmail-logo" src="https://ssl.gstatic.com/ui/v1/icons/mail/rfr/logo_gmail_lockup_default_2x_r5.png" alt="Gmail">
        </header>
        <header class="top-bar">
            <label class="search-box">
                ${icon("search", false)}
                <input class="search-input" type="search" placeholder="Search mail" aria-label="Search mail" value="${escapeHtml(state.search)}">
                ${icon("tune", false)}
            </label>
            <div class="top-actions">
                <button class="icon-button top-icon" aria-label="Help" data-action="toggle-menu" data-menu="help">${icon("help")}</button>
                <button class="icon-button top-icon" aria-label="Settings" data-action="toggle-menu" data-menu="settings">${icon("settings")}</button>
                <button class="icon-button top-icon sparkle-icon" aria-label="Connection" data-action="toggle-side-panel" data-side-panel="gemini">${icon("auto_awesome", true)}</button>
                <button class="icon-button top-icon" aria-label="Google apps" data-action="toggle-menu" data-menu="apps">${icon("apps", true)}</button>
                <button class="account-chip" aria-label="Google account" data-action="toggle-menu" data-menu="profile">
                    ${renderAccountAvatar()}
                </button>
            </div>
        </header>
    `;
}

function renderAccountAvatar(): string {
    const profilePictureUrl = state.connection?.profilePictureUrl;
    if (profilePictureUrl) {
        return `
            <span class="profile-avatar has-photo" aria-hidden="true">
                <span class="avatar-face"></span>
                <img class="profile-avatar-img" src="${escapeHtml(profilePictureUrl)}" alt="">
            </span>
        `;
    }

    return `
        <span class="profile-avatar" aria-hidden="true">
            <span class="avatar-face"></span>
        </span>
    `;
}

function renderFolder(id: FolderId, glyph: string, label: string, count = "", className = ""): string {
    const active = state.activeFolder === id;
    return `
        <button class="folder ${className}${active ? " active" : ""}" data-action="set-folder" data-folder="${id}">
            ${icon(glyph, active)}
            <span>${label}</span>
            ${count ? `<strong class="${id === "drafts" ? "muted-count" : ""}">${escapeHtml(count)}</strong>` : ""}
        </button>
    `;
}

function renderSidebar(): string {
    return `
        <aside class="sidebar">
            <button class="compose-button" data-action="open-compose" data-compose-mode="new">
                ${icon("edit")}
                <span>Compose</span>
            </button>
            <nav class="folder-list" aria-label="Mail folders">
                ${renderFolder("inbox", "inbox", "Inbox", formatCount(totalUnread()))}
                ${renderFolder("starred", "star", "Starred")}
                ${renderFolder("snoozed", "schedule", "Snoozed")}
                ${renderFolder("sent", "send", "Sent")}
                ${renderFolder("drafts", "draft", "Drafts", state.compose ? "1" : "")}
                <button class="folder category${state.activeFolder === "categories" ? " active" : ""}" data-action="toggle-categories">
                    <span class="material-symbols-outlined chevron${state.categoriesExpanded ? " expanded" : ""}">${state.categoriesExpanded ? "expand_more" : "arrow_right"}</span>
                    ${icon("label", state.activeFolder === "categories")}
                    <span>Categories</span>
                </button>
                <button class="folder more${state.activeFolder === "more" ? " active" : ""}" data-action="toggle-more">
                    ${icon(state.moreExpanded ? "expand_more" : "chevron_right")}
                    <span>More</span>
                </button>
            </nav>
            <div class="labels-heading">
                <span>Labels</span>
                <button class="icon-button label-add" aria-label="Add label" data-action="toast" data-message="Label creation is visual only">${icon("add")}</button>
            </div>
            <div class="local-session-notice">Local WhatsApp session</div>
        </aside>
    `;
}

function formatCount(count: number): string {
    return count > 999 ? "999+" : count ? String(count) : "";
}

function renderToolbar(): string {
    const rows = visibleChats();
    const allVisibleSelected = rows.length > 0 && rows.every((chat) => state.selectedIds.has(chat.remoteJid));
    const hasSelected = state.selectedIds.size > 0;
    const range = rows.length ? `1&ndash;${Math.min(rows.length, 50)} of ${rows.length}` : "0 of 0";

    return `
        <div class="toolbar ${hasSelected ? "selection-mode" : ""}">
            <div class="toolbar-left">
                <button class="select-control" aria-label="Select" data-action="toggle-select-all">
                    <span class="box${allVisibleSelected ? " checked" : ""}"></span>
                    ${icon("arrow_drop_down")}
                </button>
                <button class="icon-button toolbar-icon" aria-label="Refresh" data-action="refresh">${icon("refresh")}</button>
                <button class="icon-button toolbar-icon" aria-label="More" data-action="toggle-menu" data-menu="toolbar">${icon("more_vert")}</button>
                ${hasSelected ? `
                    <button class="icon-button toolbar-icon" aria-label="Archive selected" data-action="archive-selected">${icon("archive")}</button>
                    <button class="icon-button toolbar-icon" aria-label="Mark read selected" data-action="mark-selected-read">${icon("mail")}</button>
                ` : ""}
            </div>
            <div class="toolbar-right">
                <span class="range-text">${hasSelected ? `${state.selectedIds.size} selected` : range}</span>
                <button class="icon-button nav-button disabled" aria-label="Previous">${icon("chevron_left")}</button>
                <button class="icon-button nav-button" aria-label="Next" data-action="toast" data-message="Next page is visual only">${icon("chevron_right")}</button>
                <button class="keyboard-button" aria-label="Keyboard" data-action="toggle-menu" data-menu="keyboard">
                    <span class="ime-text">拼</span>
                    <span class="material-symbols-outlined drop">arrow_drop_down</span>
                </button>
            </div>
        </div>
    `;
}

function renderChatRow(chat: WhatsAppChatRow): string {
    const selected = state.selectedIds.has(chat.remoteJid);
    const starred = state.starredIds.has(chat.remoteJid);
    const open = state.openChatId === chat.remoteJid;
    const rowClasses = [
        "email-row",
        isUnread(chat) ? "unread" : "read",
        selected ? "selected" : "",
        open ? "opened" : "",
    ].filter(Boolean).join(" ");

    return `
        <article class="${rowClasses}" data-chat-row data-chat-id="${escapeHtml(chat.remoteJid)}">
            <div class="row-actions">
                <button class="row-check action-button" aria-label="${selected ? "Deselect" : "Select"} ${escapeHtml(chat.name)}" data-action="toggle-chat-select" data-chat-id="${escapeHtml(chat.remoteJid)}">
                    <span class="checkbox${selected ? " checked" : ""}"></span>
                </button>
                <button class="star-button action-button${starred ? " starred" : ""}" aria-label="${starred ? "Unstar" : "Star"} ${escapeHtml(chat.name)}" data-action="toggle-star" data-chat-id="${escapeHtml(chat.remoteJid)}">
                    ${icon("star", starred)}
                </button>
            </div>
            <div class="sender">${avatarInline(chat)}${escapeHtml(chat.name)}${chat.unreadCount ? ` <span class="chat-count">${escapeHtml(chat.unreadCount)}</span>` : ""}</div>
            ${renderChatPreview(chat)}
            <time>${escapeHtml(chat.timeLabel)}</time>
        </article>
    `;
}

function renderChatPreview(chat: WhatsAppChatRow): string {
    const groupSenderPreview = Boolean(chat.isGroup && chat.lastMessage);
    const senderStylePreview = groupSenderPreview || chat.subject.endsWith(":");
    const separator = senderStylePreview ? " " : "- ";

    return `
        <div class="message">
            ${renderReadReceipt(chat.lastMessage, "row-preview")}
            <span class="subject">${chat.isGroup ? `<span class="group-chip">Group</span>` : ""}${escapeHtml(chat.subject)}</span>
            ${chat.snippet ? `<span class="snippet">${separator}${escapeHtml(chat.snippet)}</span>` : ""}
        </div>
    `;
}

function avatarInline(chat: WhatsAppChatRow): string {
    if (chat.profilePicUrl) {
        return `<span class="row-avatar" style="background-image:url('${escapeHtml(chat.profilePicUrl)}')"></span>`;
    }

    const initial = (chat.name.trim()[0] || "#").toUpperCase();
    return `<span class="row-avatar">${escapeHtml(initial)}</span>`;
}

function renderInbox(): string {
    const rows = visibleChats();
    return `
        <main class="inbox-card">
            ${renderToolbar()}
            <section class="email-list" aria-label="Inbox chats">
                ${renderInboxNotice()}
                ${state.loadingChats ? renderLoadingRows() : rows.length ? rows.map(renderChatRow).join("") : renderEmptyFolder()}
            </section>
        </main>
    `;
}

function renderInboxNotice(): string {
    if (state.health && !state.health.configured) {
        return `
            <div class="system-notice error">
                <strong>Local WhatsApp server is not ready.</strong>
                <span>Start the app with npm run dev, then connect WhatsApp from the side panel.</span>
            </div>
        `;
    }

    if (state.error) {
        return `
            <div class="system-notice error">
                <strong>WhatsApp sync problem.</strong>
                <span>${escapeHtml(state.error)}</span>
            </div>
        `;
    }

    if (state.connection?.state && !["open", "connected"].includes(state.connection.state)) {
        return `
            <div class="system-notice">
                <strong>WhatsApp connection: ${escapeHtml(state.connection.state)}</strong>
                <button data-action="connect-instance">Connect</button>
            </div>
        `;
    }

    return "";
}

function renderLoadingRows(): string {
    return Array.from({ length: 10 }, (_, index) => `
        <article class="email-row skeleton-row" aria-hidden="true">
            <div class="row-actions"><span class="checkbox"></span><span class="skeleton-star"></span></div>
            <div class="sender">Loading ${index + 1}</div>
            <div class="message"><span class="subject">Syncing WhatsApp chats</span><span class="snippet">- local session</span></div>
            <time></time>
        </article>
    `).join("");
}

function renderEmptyFolder(): string {
    return `
        <div class="empty-folder">
            ${icon("inbox")}
            <p>No WhatsApp chats here</p>
        </div>
    `;
}

function renderThread(): string {
    const chat = currentChat();
    const messages = currentMessages();

    return `
        <main class="thread-card" id="thread-view" aria-label="Opened WhatsApp chat" aria-hidden="${state.openChatId ? "false" : "true"}">
            <div class="thread-toolbar">
                <button class="icon-button thread-back" aria-label="Back to inbox" data-action="close-chat">${icon("arrow_back")}</button>
                <button class="icon-button thread-tool" aria-label="Archive" data-action="archive-open">${icon("archive")}</button>
                <button class="icon-button thread-tool" aria-label="Report spam" data-action="toast" data-message="Report is visual only">${icon("report")}</button>
                <button class="icon-button thread-tool" aria-label="Delete" data-action="toast" data-message="Delete is visual only">${icon("delete")}</button>
                <span class="thread-divider"></span>
                <button class="icon-button thread-tool" aria-label="Mark unread" data-action="mark-open-unread">${icon("mail")}</button>
                <button class="icon-button thread-tool" aria-label="Snooze" data-action="toast" data-message="Snooze is visual only">${icon("schedule")}</button>
                <button class="icon-button thread-tool" aria-label="Add to tasks" data-action="toast" data-message="Added to tasks visually">${icon("add_task")}</button>
                <span class="thread-divider"></span>
                <button class="icon-button thread-tool" aria-label="Move" data-action="toast" data-message="Move menu is visual only">${icon("drive_file_move")}</button>
                <button class="icon-button thread-tool" aria-label="Label" data-action="toast" data-message="Label menu is visual only">${icon("label")}</button>
                <button class="icon-button thread-tool" aria-label="More" data-action="toggle-menu" data-menu="threadMore">${icon("more_vert")}</button>
            </div>
            <section class="thread-content">
                ${chat ? renderThreadContent(chat, messages) : renderThreadPlaceholder()}
            </section>
        </main>
    `;
}

function renderThreadContent(chat: WhatsAppChatRow, messages: WhatsAppMessage[]): string {
    return `
        <div class="thread-heading">
            <h1>${escapeHtml(chat.name)}</h1>
            <span class="thread-label">Inbox <span>x</span></span>
            ${chat.isGroup ? `<span class="thread-label whatsapp-group">Group</span>` : ""}
            <div class="thread-heading-actions">
                <button class="icon-button" aria-label="Print" data-action="toast" data-message="Print preview is visual only">${icon("print")}</button>
                <button class="icon-button" aria-label="Open in new window" data-action="toast" data-message="Pop-out window is visual only">${icon("open_in_new")}</button>
            </div>
        </div>
        <div class="thread-message-list">
            ${state.loadingMessages ? `<div class="thread-loading">Loading WhatsApp messages...</div>` : ""}
            ${messages.length ? messages.map((message) => renderMessage(chat, message)).join("") : `<div class="empty-folder thread-empty">${icon("chat_bubble")}<p>No messages loaded</p></div>`}
        </div>
        <div class="thread-footer-actions">
            <button class="reply-pill" data-action="open-compose" data-compose-mode="reply">${icon("reply")}Reply</button>
            <button class="reply-pill wide" data-action="open-compose" data-compose-mode="replyAll">${icon("reply_all")}Reply all</button>
            <button class="reply-pill wide" data-action="open-compose" data-compose-mode="forward">${icon("forward")}Forward</button>
            <button class="round-reaction" aria-label="Add reaction" data-action="toast" data-message="Choose a message to react">${icon("sentiment_satisfied")}</button>
        </div>
    `;
}

function renderThreadPlaceholder(): string {
    return `<div class="empty-folder thread-empty">${icon("chat_bubble")}<p>Select a WhatsApp chat</p></div>`;
}

function renderMessage(chat: WhatsAppChatRow, message: WhatsAppMessage): string {
    const classes = ["thread-message", message.fromMe ? "from-me" : "", message.fromMe ? "reply-message" : ""]
        .filter(Boolean)
        .join(" ");
    const sender = message.fromMe ? "me" : chat.isGroup ? message.senderName || "Someone" : chat.name;
    const avatar = renderThreadAvatar(chat, message, sender);
    const text = messageTextForThread(message);

    return `
        <article class="${classes}" data-message-id="${escapeHtml(message.id)}">
            ${avatar}
            <div class="thread-message-main">
                <header class="message-header">
                    <div>
                        <div class="message-sender">${escapeHtml(sender)}</div>
                        <div class="message-recipient">${message.fromMe ? `to ${escapeHtml(chat.name)}` : "to me"} ${message.participant && chat.isGroup ? `<span class="participant">via ${escapeHtml(message.participant)}</span>` : ""} ${icon("arrow_drop_down")}</div>
                    </div>
                    <div class="message-meta">
                        <span>${escapeHtml(message.timeLabel)}</span>
                        ${renderReadReceipt(message, "thread")}
                        <button class="icon-button tiny-icon" aria-label="Star">${icon("star")}</button>
                        <button class="icon-button tiny-icon" aria-label="Reply" data-action="open-compose" data-compose-mode="reply">${icon("reply")}</button>
                        <button class="icon-button tiny-icon" aria-label="React" data-action="react-message" data-message-id="${escapeHtml(message.id)}">${icon("sentiment_satisfied")}</button>
                    </div>
                </header>
                <div class="message-body">
                    ${renderMessageMedia(message)}
                    ${renderMessageText(text)}
                </div>
            </div>
        </article>
    `;
}

function renderReadReceipt(message: WhatsAppMessage | undefined, variant: "row-preview" | "thread"): string {
    if (!message?.fromMe) {
        return "";
    }

    const receipt = message.receipt ?? receiptFromStatus(message.status);
    if (!receipt) {
        return "";
    }

    const iconName = receipt.state === "pending"
        ? "schedule"
        : receipt.state === "error"
          ? "error"
          : receipt.state === "sent"
            ? "done"
            : "done_all";
    const label = receipt.label;

    return `
        <span class="read-receipt ${variant} ${receipt.state}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">
            ${icon(iconName)}
        </span>
    `;
}

function receiptFromStatus(status: string | undefined): WhatsAppMessage["receipt"] | undefined {
    const normalized = String(status ?? "").trim().toUpperCase();
    const map: Record<string, NonNullable<WhatsAppMessage["receipt"]>> = {
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

    return map[normalized];
}

function renderThreadAvatar(chat: WhatsAppChatRow, message: WhatsAppMessage, sender: string): string {
    const url = message.fromMe ? state.connection?.profilePictureUrl : chat.isGroup ? "" : chat.profilePicUrl;
    if (url) {
        return `<div class="thread-avatar photo-avatar" style="background-image:url('${escapeHtml(url)}')"></div>`;
    }

    if (message.fromMe) {
        return `<div class="thread-avatar face-avatar"></div>`;
    }

    const initial = (sender.trim()[0] || "?").toUpperCase();
    return `<div class="thread-avatar empty-avatar"><span>${escapeHtml(initial)}</span></div>`;
}

function messageTextForThread(message: WhatsAppMessage): string {
    if (!message.media) {
        return message.text;
    }

    if (message.media.caption) {
        return message.media.caption;
    }

    const generic = new Set(["Image message", "Video message", "Audio message", "Voice message", "Document message", "Sticker"]);
    return generic.has(message.text) ? "" : message.text;
}

function renderMessageText(text: string): string {
    if (!text) {
        return "";
    }

    return escapeHtml(text).split(/\n+/).map((line) => `<p>${line || "&nbsp;"}</p>`).join("");
}

function renderMessageMedia(message: WhatsAppMessage): string {
    if (!message.media) {
        return "";
    }

    const caption = message.media.caption || message.text;
    if (message.media.kind === "image" && message.media.url) {
        return `<figure class="media-preview" data-media-fallback="${escapeHtml(message.media.fileName || "Image unavailable")}"><img class="media-image" src="${escapeHtml(message.media.url)}" alt="${escapeHtml(caption || "Image message")}"></figure>`;
    }

    if (message.media.kind === "video" && message.media.url) {
        return `<figure class="media-preview"><video src="${escapeHtml(message.media.url)}" controls></video></figure>`;
    }

    if (message.media.kind === "audio" && message.media.url) {
        return `<figure class="media-preview audio-preview"><audio src="${escapeHtml(message.media.url)}" controls></audio></figure>`;
    }

    return `
        <${message.media.url ? `a href="${escapeHtml(message.media.url)}" target="_blank" rel="noreferrer"` : "div"} class="media-attachment">
            ${icon(mediaIcon(message.media.kind))}
            <span>${escapeHtml(message.media.fileName || message.media.kind)}</span>
        </${message.media.url ? "a" : "div"}>
    `;
}

function mediaIcon(kind: string): string {
    switch (kind) {
        case "image":
            return "image";
        case "video":
            return "movie";
        case "audio":
            return "mic";
        case "document":
            return "description";
        case "sticker":
            return "sticky_note_2";
        default:
            return "attach_file";
    }
}

function renderRightRail(): string {
    const items: Array<{ id: Exclude<SidePanelId, null>; label: string; img?: string; cls?: string }> = [
        { id: "calendar", label: "Calendar", img: "https://www.gstatic.com/companion/icon_assets/calendar_2020q4_2x.png" },
        { id: "keep", label: "Keep", img: "https://www.gstatic.com/companion/icon_assets/keep_2020q4v3_2x.png" },
        { id: "tasks", label: "Tasks", img: "https://www.gstatic.com/companion/icon_assets/tasks_2021_2x.png" },
        { id: "contacts", label: "Contacts", img: "https://www.gstatic.com/companion/icon_assets/contacts_2022_2x.png" },
        { id: "gemini", label: "WhatsApp", cls: "gemini-mark" },
    ];

    return `
        <aside class="right-rail">
            <nav class="addon-list" aria-label="Google side panel">
                ${items.map((item, index) => `
                    ${index === 4 ? `<span class="addon-divider"></span>` : ""}
                    <button class="${item.cls ?? ""}${state.sidePanel === item.id ? " active" : ""}" aria-label="${item.label}" data-action="toggle-side-panel" data-side-panel="${item.id}">
                        ${item.img ? `<img src="${item.img}" alt="${item.label}">` : "<span></span>"}
                    </button>
                `).join("")}
                <button class="plus-button" aria-label="Add-ons" data-action="toast" data-message="Add-ons are visual only">${icon("add")}</button>
            </nav>
            <button class="collapse-button" aria-label="Collapse side panel" data-action="toggle-side-panel" data-side-panel="none">${icon("chevron_right")}</button>
        </aside>
    `;
}

function renderSidePanel(): string {
    if (!state.sidePanel) {
        return "";
    }

    if (state.sidePanel === "gemini") {
        return renderWhatsAppPanel();
    }

    const titles: Record<Exclude<SidePanelId, null>, string> = {
        calendar: "Calendar",
        keep: "Keep",
        tasks: "Tasks",
        contacts: "Contacts",
        gemini: "WhatsApp",
    };
    const icons: Record<Exclude<SidePanelId, null>, string> = {
        calendar: "event",
        keep: "lightbulb",
        tasks: "check_circle",
        contacts: "person",
        gemini: "",
    };

    return `
        <aside class="side-panel-flyout" data-menu-root>
            <div class="side-panel-header">
                <strong>${titles[state.sidePanel]}</strong>
                <button class="icon-button" aria-label="Close ${titles[state.sidePanel]}" data-action="close-side-panel">${icon("close")}</button>
            </div>
            <div class="side-panel-body">
                <span class="side-panel-large-icon">${icons[state.sidePanel] ? icon(icons[state.sidePanel]) : ""}</span>
                <p>${titles[state.sidePanel]} preview</p>
                <span>This panel is interactive UI only.</span>
            </div>
        </aside>
    `;
}

function renderWhatsAppPanel(): string {
    const pairingCode = state.connection?.pairingCode;
    return `
        <aside class="side-panel-flyout local-session-panel" data-menu-root>
            <div class="side-panel-header">
                <strong>WhatsApp</strong>
                <button class="icon-button" aria-label="Close WhatsApp panel" data-action="close-side-panel">${icon("close")}</button>
            </div>
            <div class="side-panel-body">
                <span class="side-panel-large-icon">${icon("hub")}</span>
                <p>${escapeHtml(state.connection?.state ?? "unknown")}</p>
                <span>${escapeHtml(state.connection?.profileName ?? state.health?.instanceName ?? "Local session")}</span>
                ${renderQrCode()}
                ${pairingCode ? `<div class="pairing-code">${escapeHtml(pairingCode)}</div>` : ""}
                <label class="pairing-form">
                    <span>Phone</span>
                    <input data-pairing-phone type="tel" placeholder="60123456789">
                </label>
                <button class="reply-pill wide panel-action" data-action="request-pairing-code">Pair by code</button>
                <button class="send-button panel-action" data-action="connect-instance">Connect</button>
                <button class="reply-pill wide panel-action" data-action="reset-local-session">Reset session</button>
                <small>Runs locally with Baileys</small>
            </div>
        </aside>
    `;
}

function renderQrCode(): string {
    const qr = extractQrImage(state.connection?.qrcode);
    return qr ? `<img class="qr-preview" src="${escapeHtml(qr)}" alt="WhatsApp QR code">` : "";
}

function extractQrImage(qrcode: unknown): string {
    if (!qrcode || typeof qrcode !== "object") {
        return "";
    }

    const base64 = (qrcode as { base64?: unknown }).base64;
    return typeof base64 === "string" ? base64 : "";
}

function renderCompose(): string {
    if (!state.compose) {
        return "";
    }

    const cls = [
        "compose-window",
        state.compose.minimized ? "minimized" : "",
        state.compose.expanded ? "expanded" : "",
    ].filter(Boolean).join(" ");

    return `
        <section class="${cls}" aria-label="New message">
            <header class="compose-header">
                <span>${state.compose.mode === "new" ? "New Message" : "Reply"}</span>
                <div>
                    <button class="icon-button compose-control" aria-label="Minimize" data-action="toggle-compose-minimized">${icon("remove")}</button>
                    <button class="icon-button compose-control" aria-label="Expand" data-action="toggle-compose-expanded">${icon(state.compose.expanded ? "close_fullscreen" : "open_in_full")}</button>
                    <button class="icon-button compose-control" aria-label="Close compose" data-action="close-compose">${icon("close")}</button>
                </div>
            </header>
            ${state.compose.minimized ? "" : `
                <label class="compose-line">
                    <span>To</span>
                    <input value="${escapeHtml(state.compose.to)}" aria-label="To" data-compose-to>
                </label>
                <label class="compose-line">
                    <input value="${escapeHtml(state.compose.subject)}" aria-label="Subject">
                </label>
                <div class="compose-body" contenteditable="true" aria-label="Message body">${state.compose.mode === "new" ? "" : "<br><br>"}</div>
                <footer class="compose-footer">
                    <button class="send-button" data-action="send-compose">Send</button>
                    <button class="icon-button" aria-label="Formatting">${icon("format_color_text")}</button>
                    <label class="icon-button attach-label" aria-label="Attach">
                        ${icon("attach_file")}
                        <input class="compose-file-input" type="file" data-compose-file>
                    </label>
                    <button class="icon-button" aria-label="Insert link">${icon("link")}</button>
                    <button class="icon-button" aria-label="Emoji">${icon("mood")}</button>
                    <button class="icon-button trash-compose" aria-label="Discard draft" data-action="close-compose">${icon("delete")}</button>
                </footer>
            `}
        </section>
    `;
}

function renderPopover(): string {
    if (!state.menu) {
        return "";
    }

    const menuContent = {
        status: `
            <button data-action="set-status" data-status="Active"><span class="status-dot"></span>Active</button>
            <button data-action="set-status" data-status="Do not disturb"><span class="status-dot red"></span>Do not disturb</button>
            <button data-action="set-status" data-status="Away"><span class="status-dot yellow"></span>Away</button>
        `,
        help: `
            <strong>Help</strong>
            <button data-action="toast" data-message="Help opened visually">Help center</button>
            <button data-action="toast" data-message="Keyboard shortcuts are visual only">Keyboard shortcuts</button>
        `,
        settings: `
            <strong>Quick settings</strong>
            <button data-action="toggle-side-panel" data-side-panel="gemini">WhatsApp connection: ${escapeHtml(state.connection?.state ?? "unknown")}</button>
            <button data-action="connect-instance">Connect WhatsApp</button>
            <button data-action="toast" data-message="Density changed visually">Display density</button>
            <button data-action="toast" data-message="Theme picker is visual only">Theme</button>
        `,
        apps: `
            <strong>Google apps</strong>
            <div class="apps-grid">
                <button data-action="set-rail" data-rail="mail">${icon("mail", true)}Mail</button>
                <button data-action="set-rail" data-rail="chat">${icon("chat_bubble")}Chat</button>
                <button data-action="set-rail" data-rail="meet">${icon("videocam")}Meet</button>
            </div>
        `,
        profile: `
            <strong>${escapeHtml(state.health?.instanceName ?? "WhatsAppMail")}</strong>
            <button data-action="toggle-side-panel" data-side-panel="gemini">WhatsApp session status</button>
            <button data-action="toast" data-message="Profile opened visually">Manage your Google Account</button>
            <button data-action="toast" data-message="Sign out is visual only">Sign out</button>
        `,
        toolbar: `
            <button data-action="mark-selected-read">Mark as read</button>
            <button data-action="archive-selected">Archive selected</button>
            <button data-action="toast" data-message="Filter menu is visual only">Filter messages like these</button>
        `,
        keyboard: `
            <button data-action="toast" data-message="Keyboard shortcuts enabled visually">Keyboard shortcuts on</button>
            <button data-action="toast" data-message="Input tools are visual only">Input tools</button>
        `,
        threadMore: `
            <button data-action="mark-open-unread">Mark unread</button>
            <button data-action="archive-open">Archive chat</button>
            <button data-action="toast" data-message="Printed visually">Print all</button>
        `,
    };

    return `<div class="popover ${state.menu}-popover" data-menu-root>${menuContent[state.menu]}</div>`;
}

function renderToast(): string {
    return state.toast ? `<div class="toast">${escapeHtml(state.toast)}</div>` : "";
}

function renderShell(): string {
    const shellClasses = [
        "app-shell",
        state.openChatId ? "mail-open" : "",
        state.sidebarCollapsed ? "sidebar-collapsed" : "",
    ].filter(Boolean).join(" ");

    return `
        <div class="${shellClasses}">
            ${renderRail()}
            ${renderTopBar()}
            ${renderSidebar()}
            ${renderInbox()}
            ${renderThread()}
            ${renderRightRail()}
        </div>
        ${renderSidePanel()}
        ${renderCompose()}
        ${renderPopover()}
        ${renderToast()}
    `;
}

function render(): void {
    app.innerHTML = renderShell();
    afterRender();
}

function afterRender(): void {
    if (!pendingThreadScrollBottom) {
        return;
    }

    pendingThreadScrollBottom = false;
    window.requestAnimationFrame(() => {
        const threadContent = app.querySelector<HTMLElement>(".thread-content");
        if (threadContent) {
            threadContent.scrollTop = threadContent.scrollHeight;
        }
    });
}

function showToast(message: string): void {
    state.toast = message;
    render();

    if (toastTimer) {
        window.clearTimeout(toastTimer);
    }

    toastTimer = window.setTimeout(() => {
        state.toast = null;
        render();
    }, 2200);
}

function restoreClientCache(): void {
    try {
        const raw = window.localStorage.getItem(CLIENT_CACHE_KEY);
        if (!raw) {
            return;
        }

        const cache = JSON.parse(raw) as Partial<ClientCache>;
        if (Array.isArray(cache.chats)) {
            state.chats = cache.chats;
            state.loadingChats = false;
        }
        if (cache.messagesByChat && typeof cache.messagesByChat === "object" && !Array.isArray(cache.messagesByChat)) {
            state.messagesByChat = cache.messagesByChat as Record<string, WhatsAppMessage[]>;
        }
        state.starredIds = new Set(Array.isArray(cache.starredIds) ? cache.starredIds : []);
        state.localReadIds = new Set(Array.isArray(cache.localReadIds) ? cache.localReadIds : []);
        state.archivedIds = new Set(Array.isArray(cache.archivedIds) ? cache.archivedIds : []);
    } catch {
        window.localStorage.removeItem(CLIENT_CACHE_KEY);
    }
}

function saveClientCache(): void {
    try {
        const cache: ClientCache = {
            chats: state.chats.slice(0, 200),
            messagesByChat: Object.fromEntries(
                Object.entries(state.messagesByChat).map(([remoteJid, messages]) => [remoteJid, messages.slice(-200)]),
            ),
            starredIds: [...state.starredIds],
            localReadIds: [...state.localReadIds],
            archivedIds: [...state.archivedIds],
            savedAt: Date.now(),
        };
        window.localStorage.setItem(CLIENT_CACHE_KEY, JSON.stringify(cache));
    } catch {
        // Browser storage can be unavailable; the app still works from the local server.
    }
}

function clearClientCache(): void {
    try {
        window.localStorage.removeItem(CLIENT_CACHE_KEY);
    } catch {
        // Ignore storage failures during reset.
    }
}

async function initialize(): Promise<void> {
    render();
    await refreshHealthAndConnection();

    await loadChats();
    events = subscribeEvents(handleServerEvent, () => {
        state.error = "Live updates disconnected. Manual refresh still works.";
        render();
    });
}

async function refreshHealthAndConnection(): Promise<void> {
    try {
        state.health = await getHealth();
        state.connection = await getConnection();
        state.error = null;
    } catch (error) {
        state.error = error instanceof Error ? error.message : "Unable to reach local WhatsApp server.";
    }
    render();
}

async function loadChats(options: LoadOptions = {}): Promise<void> {
    const showLoading = options.showLoading ?? state.chats.length === 0;
    if (showLoading) {
        state.loadingChats = true;
        render();
    }

    try {
        const response = await getChats({ limit: 100 });
        if (response.chats.length || state.chats.length === 0) {
            state.chats = response.chats;
            if (response.chats.length) {
                saveClientCache();
            }
            state.error = null;
        } else {
            state.error = "Using local chat cache while WhatsApp history finishes syncing.";
        }
    } catch (error) {
        state.error = error instanceof Error ? error.message : "Could not load WhatsApp chats.";
    } finally {
        if (showLoading) {
            state.loadingChats = false;
        }
        render();
    }
}

async function loadMessages(remoteJid: string, options: LoadOptions = {}): Promise<void> {
    const showLoading = options.showLoading ?? !(state.messagesByChat[remoteJid]?.length);
    const scrollToBottom = options.scrollToBottom ?? remoteJid === state.openChatId;
    if (showLoading) {
        state.loadingMessages = true;
    }
    if (scrollToBottom && remoteJid === state.openChatId) {
        pendingThreadScrollBottom = true;
    }
    if (showLoading) {
        render();
    }

    try {
        const response = await getMessages(remoteJid, 1, 200);
        state.messagesByChat[remoteJid] = response.messages;
        if (response.messages.length) {
            saveClientCache();
        }
        state.error = null;
        if (scrollToBottom && remoteJid === state.openChatId) {
            pendingThreadScrollBottom = true;
        }
    } catch (error) {
        state.error = error instanceof Error ? error.message : "Could not load WhatsApp messages.";
    } finally {
        if (showLoading) {
            state.loadingMessages = false;
        }
        render();
    }
}

function handleServerEvent(payload: ServerEventPayload): void {
    if (payload.type === "connection.update") {
        state.connection = eventConnectionState(payload.data);
        render();
    }

    if (payload.type === "qrcode.updated") {
        state.connection = {
            configured: true,
            instanceName: state.health?.instanceName ?? undefined,
            state: "connecting",
            qrcode: readEventData(payload.data),
        };
        render();
    }

    if (payload.type === "messages.upsert" || payload.type === "messages.update") {
        const data = readEventData(payload.data);
        const record = typeof data === "object" && data ? data as Record<string, unknown> : {};
        const localStateOnlyUpdate = payload.type === "messages.update"
            && typeof record.remoteJid === "string"
            && record.changed !== true
            && record.chats !== true
            && record.profilePicUrl !== true;
        if (localStateOnlyUpdate) {
            return;
        }

        const shouldReloadOpenMessages = payload.type === "messages.upsert" || record.changed === true;

        void loadChats({ showLoading: false });
        if (state.openChatId && shouldReloadOpenMessages) {
            void loadMessages(state.openChatId, {
                showLoading: false,
                scrollToBottom: payload.type === "messages.upsert",
            });
        }
    }
}

function eventConnectionState(data: unknown): ConnectionState {
    const inner = readEventData(data);
    const record = typeof inner === "object" && inner ? inner as Record<string, unknown> : {};
    const stateText = typeof record.status === "string"
        ? record.status
        : typeof record.state === "string"
          ? record.state
          : "unknown";

    return {
        configured: true,
        instanceName: state.health?.instanceName ?? undefined,
        state: stateText,
        message: typeof record.lastDisconnectReason === "string"
            ? record.lastDisconnectReason
            : typeof record.message === "string"
              ? record.message
              : undefined,
        qrcode: record.qr ?? record.qrcode,
        pairingCode: typeof record.pairingCode === "string" ? record.pairingCode : null,
        pairingPhone: typeof record.pairingPhone === "string" ? record.pairingPhone : null,
        ownerJid: typeof record.ownerJid === "string" ? record.ownerJid : null,
        profileName: typeof record.profileName === "string" ? record.profileName : null,
        profilePictureUrl: typeof record.profilePictureUrl === "string" ? record.profilePictureUrl : null,
        hasAuthState: typeof record.hasAuthState === "boolean" ? record.hasAuthState : undefined,
    };
}

function readEventData(data: unknown): unknown {
    if (typeof data === "object" && data && "data" in data) {
        return (data as { data: unknown }).data;
    }

    return data;
}

function readEventState(data: unknown): string {
    const inner = readEventData(data);
    if (typeof inner === "object" && inner) {
        const record = inner as { state?: unknown; status?: unknown };
        return typeof record.state === "string" ? record.state : typeof record.status === "string" ? record.status : "unknown";
    }

    return "unknown";
}

async function openChat(remoteJid: string): Promise<void> {
    state.openChatId = remoteJid;
    state.activeFolder = "inbox";
    state.selectedIds.clear();
    state.localReadIds.add(remoteJid);
    state.menu = null;
    pendingThreadScrollBottom = true;
    history.replaceState(null, "", "#open-chat");
    render();
    await Promise.allSettled([
        loadMessages(remoteJid, {
            showLoading: !(state.messagesByChat[remoteJid]?.length),
            scrollToBottom: true,
        }),
        markChatRead(remoteJid, currentChat()?.lastMessage?.key),
    ]);
}

function closeChat(): void {
    state.openChatId = null;
    state.menu = null;
    if (window.location.hash === "#open-chat") {
        history.replaceState(null, "", window.location.pathname);
    }
    render();
}

function setFolder(folder: FolderId): void {
    state.activeFolder = folder;
    state.menu = null;
    if (folder !== "inbox") {
        state.openChatId = null;
    }
    render();
}

function toggleSelectAll(): void {
    const rows = visibleChats();
    const allSelected = rows.length > 0 && rows.every((chat) => state.selectedIds.has(chat.remoteJid));
    if (allSelected) {
        rows.forEach((chat) => state.selectedIds.delete(chat.remoteJid));
    } else {
        rows.forEach((chat) => state.selectedIds.add(chat.remoteJid));
    }
    render();
}

function openCompose(mode: ComposeMode): void {
    const chat = currentChat();
    state.compose = {
        mode,
        minimized: false,
        expanded: false,
        remoteJid: mode === "new" ? "" : chat?.remoteJid ?? "",
        to: mode === "new" ? "" : chat?.remoteJid ?? "",
        subject: mode === "new" ? "" : `Re: ${chat?.name ?? "WhatsApp chat"}`,
    };
    state.menu = null;
    render();
}

async function sendCompose(target: HTMLElement): Promise<void> {
    const compose = target.closest(".compose-window") as HTMLElement | null;
    const to = (compose?.querySelector("[data-compose-to]") as HTMLInputElement | null)?.value.trim() ?? "";
    const body = (compose?.querySelector(".compose-body") as HTMLElement | null)?.innerText.trim() ?? "";
    const remoteJid = state.compose?.remoteJid || to;

    if (!remoteJid || !body) {
        showToast("Add a WhatsApp chat and message first");
        return;
    }

    const temp = makeOptimisticMessage(remoteJid, body);
    addMessage(temp);
    state.compose = null;
    render();

    try {
        const response = await sendText(remoteJid, body);
        replaceMessage(temp.id, {
            ...response.message,
            remoteJid: response.message.remoteJid || remoteJid,
        });
        showToast("Message sent");
        await loadChats();
    } catch (error) {
        removeMessage(temp.id, remoteJid);
        showToast(error instanceof Error ? error.message : "Message failed");
    }
}

async function handleMediaFile(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    if (!file) {
        return;
    }

    const compose = input.closest(".compose-window") as HTMLElement | null;
    const to = (compose?.querySelector("[data-compose-to]") as HTMLInputElement | null)?.value.trim() ?? "";
    const caption = (compose?.querySelector(".compose-body") as HTMLElement | null)?.innerText.trim() ?? "";
    const remoteJid = state.compose?.remoteJid || to || state.openChatId || "";

    if (!remoteJid) {
        showToast("Open a chat or add a recipient first");
        input.value = "";
        return;
    }

    try {
        showToast("Uploading media");
        const response = await sendMedia(remoteJid, file, caption);
        addMessage({ ...response.message, remoteJid: response.message.remoteJid || remoteJid });
        await loadChats();
        input.value = "";
    } catch (error) {
        showToast(error instanceof Error ? error.message : "Media send failed");
    }
}

function makeOptimisticMessage(remoteJid: string, text: string): WhatsAppMessage {
    const timestamp = Math.floor(Date.now() / 1000);
    return {
        id: `temp-${timestamp}`,
        remoteJid,
        fromMe: true,
        senderName: "me",
        type: "Text message",
        text,
        timestamp,
        timeLabel: "now",
        status: "PENDING",
        receipt: {
            state: "pending",
            label: "Pending",
            code: "PENDING",
        },
        key: {
            id: `temp-${timestamp}`,
            remoteJid,
            fromMe: true,
        },
    };
}

function addMessage(message: WhatsAppMessage): void {
    const current = state.messagesByChat[message.remoteJid] ?? [];
    state.messagesByChat[message.remoteJid] = [...current, message].sort((a, b) => a.timestamp - b.timestamp);
    upsertChatFromMessage(message);
}

function replaceMessage(tempId: string, message: WhatsAppMessage): void {
    const current = state.messagesByChat[message.remoteJid] ?? [];
    state.messagesByChat[message.remoteJid] = current.map((item) => item.id === tempId ? message : item);
    upsertChatFromMessage(message);
    render();
}

function removeMessage(messageId: string, remoteJid: string): void {
    state.messagesByChat[remoteJid] = (state.messagesByChat[remoteJid] ?? []).filter((message) => message.id !== messageId);
    render();
}

function upsertChatFromMessage(message: WhatsAppMessage): void {
    const existing = state.chats.find((chat) => chat.remoteJid === message.remoteJid);
    if (existing) {
        existing.lastMessage = message;
        existing.subject = message.fromMe
            ? message.type === "Text message" ? "You:" : `You: ${message.type}`
            : message.type === "Text message" ? message.text : message.type;
        existing.snippet = message.text;
        existing.timestamp = message.timestamp;
        existing.timeLabel = message.timeLabel;
        saveClientCache();
        return;
    }

    state.chats = [{
        id: message.remoteJid,
        remoteJid: message.remoteJid,
        name: message.remoteJid,
        subject: message.fromMe
            ? message.type === "Text message" ? "You:" : `You: ${message.type}`
            : message.type === "Text message" ? message.text : message.type,
        snippet: message.text,
        timestamp: message.timestamp,
        timeLabel: message.timeLabel,
        unreadCount: 0,
        isGroup: message.remoteJid.endsWith("@g.us"),
        isSaved: false,
        lastMessage: message,
    }, ...state.chats];
    saveClientCache();
}

async function markSelectedRead(): Promise<void> {
    const ids = [...state.selectedIds];
    await Promise.allSettled(ids.map((id) => markChatRead(id, state.chats.find((chat) => chat.remoteJid === id)?.lastMessage?.key)));
    ids.forEach((id) => state.localReadIds.add(id));
    saveClientCache();
    showToast(ids.length ? "Marked as read" : "Select conversations first");
}

async function archiveSelected(): Promise<void> {
    const ids = [...state.selectedIds];
    if (!ids.length) {
        showToast("Select conversations first");
        return;
    }

    await Promise.allSettled(ids.map((id) => archiveChat(id, state.chats.find((chat) => chat.remoteJid === id)?.lastMessage?.key)));
    ids.forEach((id) => state.archivedIds.add(id));
    state.selectedIds.clear();
    saveClientCache();
    showToast(`${ids.length} conversation${ids.length === 1 ? "" : "s"} archived`);
    render();
}

async function archiveOpen(): Promise<void> {
    const chat = currentChat();
    if (!chat) {
        return;
    }

    await archiveChat(chat.remoteJid, chat.lastMessage?.key);
    state.archivedIds.add(chat.remoteJid);
    saveClientCache();
    closeChat();
    showToast("Chat archived");
}

async function markOpenUnread(): Promise<void> {
    const chat = currentChat();
    if (!chat) {
        return;
    }

    await markChatUnread(chat.remoteJid, chat.lastMessage?.key);
    state.localReadIds.delete(chat.remoteJid);
    chat.unreadCount = Math.max(chat.unreadCount, 1);
    saveClientCache();
    showToast("Marked unread");
    render();
}

async function reactToMessage(messageId: string): Promise<void> {
    const message = currentMessages().find((item) => item.id === messageId);
    const reaction = window.prompt("Reaction emoji", "");
    if (!message || reaction === null) {
        return;
    }

    await sendReaction(message.key, reaction);
    showToast(reaction ? "Reaction sent" : "Reaction removed");
}

async function connectWhatsApp(): Promise<void> {
    try {
        state.connection = await connectInstance();
        state.sidePanel = "gemini";
        showToast("Connection requested");
        render();
    } catch (error) {
        showToast(error instanceof Error ? error.message : "Connection failed");
    }
}

async function pairByCode(target: HTMLElement): Promise<void> {
    const panel = target.closest(".local-session-panel") as HTMLElement | null;
    const phoneNumber = (panel?.querySelector("[data-pairing-phone]") as HTMLInputElement | null)?.value.trim() ?? "";
    if (!phoneNumber) {
        showToast("Enter your WhatsApp phone number");
        return;
    }

    try {
        state.connection = await requestPairingCode(phoneNumber);
        state.sidePanel = "gemini";
        showToast("Pairing code generated");
        render();
    } catch (error) {
        showToast(error instanceof Error ? error.message : "Pairing code failed");
    }
}

async function resetSession(): Promise<void> {
    try {
        state.connection = await resetLocalSession();
        state.chats = [];
        state.messagesByChat = {};
        state.openChatId = null;
        state.sidePanel = "gemini";
        clearClientCache();
        showToast("Local WhatsApp session reset");
        render();
    } catch (error) {
        showToast(error instanceof Error ? error.message : "Reset failed");
    }
}

async function handleAction(target: HTMLElement): Promise<void> {
    const action = target.dataset.action;

    switch (action) {
        case "toggle-menu": {
            const menu = target.dataset.menu as AppState["menu"];
            state.menu = state.menu === menu ? null : menu;
            render();
            return;
        }
        case "toggle-sidebar":
            state.sidebarCollapsed = !state.sidebarCollapsed;
            state.menu = null;
            render();
            return;
        case "set-status": {
            const status = target.dataset.status as AppState["status"];
            state.status = status;
            state.menu = null;
            render();
            return;
        }
        case "set-rail": {
            const rail = target.dataset.rail as RailId;
            state.activeRail = rail;
            state.menu = null;
            showToast(`${rail[0].toUpperCase()}${rail.slice(1)} selected`);
            return;
        }
        case "set-folder":
            setFolder(target.dataset.folder as FolderId);
            return;
        case "toggle-categories":
            state.categoriesExpanded = !state.categoriesExpanded;
            state.activeFolder = "categories";
            state.openChatId = null;
            render();
            return;
        case "toggle-more":
            state.moreExpanded = !state.moreExpanded;
            state.activeFolder = "more";
            state.openChatId = null;
            render();
            return;
        case "toggle-chat-select": {
            const id = target.dataset.chatId;
            if (id && state.selectedIds.has(id)) {
                state.selectedIds.delete(id);
            } else if (id) {
                state.selectedIds.add(id);
            }
            render();
            return;
        }
        case "toggle-select-all":
            toggleSelectAll();
            return;
        case "toggle-star": {
            const id = target.dataset.chatId;
            if (id && state.starredIds.has(id)) {
                state.starredIds.delete(id);
            } else if (id) {
                state.starredIds.add(id);
            }
            render();
            return;
        }
        case "refresh":
            await refreshHealthAndConnection();
            await loadChats({ showLoading: true });
            showToast("Inbox refreshed");
            return;
        case "archive-selected":
            await archiveSelected();
            return;
        case "mark-selected-read":
            await markSelectedRead();
            return;
        case "close-chat":
            closeChat();
            return;
        case "mark-open-unread":
            await markOpenUnread();
            return;
        case "archive-open":
            await archiveOpen();
            return;
        case "open-compose":
            openCompose((target.dataset.composeMode as ComposeMode | undefined) ?? "new");
            return;
        case "send-compose":
            await sendCompose(target);
            return;
        case "toggle-compose-minimized":
            if (state.compose) {
                state.compose.minimized = !state.compose.minimized;
            }
            render();
            return;
        case "toggle-compose-expanded":
            if (state.compose) {
                state.compose.expanded = !state.compose.expanded;
            }
            render();
            return;
        case "close-compose":
            state.compose = null;
            render();
            return;
        case "toggle-side-panel": {
            const panel = target.dataset.sidePanel as SidePanelId | "none";
            state.sidePanel = panel === "none" || state.sidePanel === panel ? null : panel;
            state.menu = null;
            render();
            return;
        }
        case "close-side-panel":
            state.sidePanel = null;
            state.menu = null;
            render();
            return;
        case "connect-instance":
            await connectWhatsApp();
            return;
        case "request-pairing-code":
            await pairByCode(target);
            return;
        case "reset-local-session":
            await resetSession();
            return;
        case "react-message":
            await reactToMessage(target.dataset.messageId ?? "");
            return;
        case "toast":
            showToast(target.dataset.message ?? "Action applied visually");
            return;
        default:
            return;
    }
}

app.addEventListener("click", (event) => {
    const target = event.target as Element;
    const actionTarget = target.closest("[data-action]") as HTMLElement | null;

    if (actionTarget) {
        event.preventDefault();
        event.stopPropagation();
        void handleAction(actionTarget);
        return;
    }

    const row = target.closest("[data-chat-row]") as HTMLElement | null;
    if (row?.dataset.chatId) {
        void openChat(row.dataset.chatId);
        return;
    }

    if (state.menu && !target.closest("[data-menu-root]")) {
        state.menu = null;
        render();
    }
});

app.addEventListener("input", (event) => {
    const target = event.target as HTMLInputElement;
    if (!target.classList.contains("search-input")) {
        return;
    }

    const selectionStart = target.selectionStart;
    state.search = target.value;
    render();
    const next = app.querySelector<HTMLInputElement>(".search-input");
    next?.focus();
    if (selectionStart !== null) {
        next?.setSelectionRange(selectionStart, selectionStart);
    }
});

app.addEventListener("change", (event) => {
    const target = event.target as HTMLInputElement;
    if (target.matches("[data-compose-file]")) {
        void handleMediaFile(target);
    }
});

app.addEventListener("error", (event) => {
    const target = event.target;
    if (target instanceof HTMLImageElement && target.classList.contains("profile-avatar-img")) {
        target.remove();
    }

    if (target instanceof HTMLImageElement && target.classList.contains("media-image")) {
        const figure = target.closest<HTMLElement>(".media-preview");
        if (figure) {
            figure.innerHTML = `
                <div class="media-unavailable">
                    ${icon("image_not_supported")}
                    <span>${escapeHtml(figure.dataset.mediaFallback || "Image unavailable")}</span>
                </div>
            `;
        }
    }
}, true);

window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
        state.menu = null;
        if (state.compose?.expanded) {
            state.compose.expanded = false;
        } else if (state.sidePanel) {
            state.sidePanel = null;
        } else if (state.openChatId) {
            state.openChatId = null;
        }
        render();
    }
});

window.addEventListener("beforeunload", () => {
    events?.close();
});

restoreClientCache();
void initialize();
