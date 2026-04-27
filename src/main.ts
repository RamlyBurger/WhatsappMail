type RailId = "mail" | "chat" | "meet";
type FolderId = "inbox" | "starred" | "snoozed" | "sent" | "drafts" | "categories" | "more";
type MenuId = "status" | "help" | "settings" | "apps" | "profile" | "toolbar" | "keyboard" | "threadMore" | null;
type SidePanelId = "calendar" | "keep" | "tasks" | "contacts" | "gemini" | null;
type ComposeMode = "new" | "reply" | "replyAll" | "forward";

interface Email {
    id: string;
    sender: string;
    count?: string;
    subject: string;
    snippet: string;
    time: string;
    read: boolean;
    highlighted?: boolean;
}

interface ComposeState {
    mode: ComposeMode;
    minimized: boolean;
    expanded: boolean;
    to: string;
    subject: string;
}

interface AppState {
    activeRail: RailId;
    activeFolder: FolderId;
    openEmailId: string | null;
    selectedIds: Set<string>;
    starredIds: Set<string>;
    readIds: Set<string>;
    menu: MenuId;
    status: "Active" | "Do not disturb" | "Away";
    sidePanel: SidePanelId;
    compose: ComposeState | null;
    toast: string | null;
    categoriesExpanded: boolean;
    moreExpanded: boolean;
    sidebarCollapsed: boolean;
}

const emails: Email[] = [
    {
        id: "chatgpt-login-745860",
        sender: "noreply",
        count: "2",
        subject: "Your temporary ChatGPT login code",
        snippet: "Enter this temporary verification code to continue: 745860. ChatGPT Log-in Code Hi there, We noticed a suspicious log-in on your account...",
        time: "9:43 AM",
        read: true,
        highlighted: true
    },
    {
        id: "economist-secret-service",
        sender: "The Economist Today",
        subject: "Fresh questions about the Secret Service&rsquo;s competence",
        snippet: "Also: Can you outrun depression and anxiety? The Economist April 26th 2026 The Economist Today A Sunday editio...",
        time: "3:37 AM",
        read: false
    },
    {
        id: "namecom-survey",
        sender: "name.com",
        subject: "We&rsquo;d love to hear from you!",
        snippet: "Fill out our survey to share your feedback.",
        time: "11:01 PM",
        read: false
    },
    {
        id: "chatgpt-login-856763",
        sender: "noreply",
        count: "7",
        subject: "Your temporary ChatGPT login code",
        snippet: "Enter this temporary verification code to continue: 856763. ChatGPT Log-in Code Hi there, We noticed a suspicious log-in on your acco...",
        time: "Apr 26",
        read: false
    },
    {
        id: "openai-plan",
        sender: "OpenAI",
        count: "2",
        subject: "ChatGPT - Your new plan",
        snippet: "Manage your account: https://chatgpt.com/account/manage?account_id=efe296d9-d2b8-4f52-82a7-7ac2a839bd54. You&rsquo;ve successfully subscribed t...",
        time: "Apr 26",
        read: true
    },
    {
        id: "verification-824908",
        sender: "noreply",
        subject: "Your temporary ChatGPT verification code",
        snippet: "Enter this temporary verification code to continue: 824908 Please ignore this email if this wasn&rsquo;t you trying to create a ChatGPT acc...",
        time: "Apr 26",
        read: true
    },
    {
        id: "verification-977361",
        sender: "OpenAI",
        subject: "Your temporary ChatGPT verification code",
        snippet: "Enter this temporary verification code to continue: 977361 Please ignore this email if this wasn&rsquo;t you trying to create a ChatGPT acco...",
        time: "Apr 26",
        read: true
    },
    {
        id: "business-ended",
        sender: "OpenAI",
        count: "2",
        subject: "Your ChatGPT Business trial has ended",
        snippet: "You canceled your ChatGPT Business trial, and your trial access has now ended. Your workspace no longer has access to Business featu...",
        time: "Apr 26",
        read: true
    },
    {
        id: "deactivated-1",
        sender: "noreply",
        subject: "OpenAI - Access Deactivated [C-8gKZlbFYp8ET]",
        snippet: "Access deactivated Hello, OpenAI&rsquo;s terms and policies restrict the use of our services in a number of areas. We have identified ...",
        time: "Apr 26",
        read: true
    },
    {
        id: "deactivated-2",
        sender: "noreply",
        subject: "OpenAI - Access Deactivated [C-WeGpzQuWVelP]",
        snippet: "Access deactivated Hello, OpenAI&rsquo;s terms and policies restrict the use of our services in a number of areas. We have identifi...",
        time: "Apr 26",
        read: true
    },
    {
        id: "npm-publish",
        sender: "npm",
        subject: "Successfully published @ramlyburger/gpt-image-2-mcp@0.2.1",
        snippet: "Hi ramlyburger! A new version of the package @ramlyburger/gpt-image-2-mcp (0.2.1) was published at 202...",
        time: "Apr 26",
        read: false
    },
    {
        id: "npm-2fa",
        sender: "npm",
        subject: "[npm] Two-factor authentication enabled",
        snippet: "Two-factor authentication enabled Hi, ramlyburger! It looks like you enabled two-factor authentication (2FA) on your npm account. Pl...",
        time: "Apr 26",
        read: true
    },
    {
        id: "npm-key",
        sender: "npm",
        subject: "[npm] A security key was added to your account",
        snippet: "Your security device has been added successfully. Hi, ramlyburger! Your security key ramlyburger-npm has been successfu...",
        time: "Apr 26",
        read: false
    },
    {
        id: "npm-otp",
        sender: "npm",
        subject: "[npm] OTP for complete the sign up for you new npm account: ramlyburger",
        snippet: "Your sign up requires an OTP to finish setup your npm account. Welcome to npm, ramlyburger! To c...",
        time: "Apr 26",
        read: true
    },
    {
        id: "pr-license",
        sender: "David Jun",
        subject: "[RamlyBurger/gpt-image-2-mcp] Add MIT license (PR #6)",
        snippet: "Summary Add a root LICENSE file with the standard MIT License text. Use 2026 Low Nam Lee as the copyright h...",
        time: "Apr 26",
        read: false
    },
    {
        id: "pr-backends",
        sender: "David Jun",
        subject: "[RamlyBurger/gpt-image-2-mcp] Add selectable API and ChatGPT web backends (PR #4)",
        snippet: "Summary Add a TypeScript MCP server as the main entry point. Add selectabl...",
        time: "Apr 26",
        read: false
    },
    {
        id: "devpost",
        sender: "Cassie from Devpost",
        subject: "HACKATHONS just for you, Burger",
        snippet: "Hey Burger, Since you&rsquo;ve recently joined Devpost, we wanted to let you know about our trending hackathons. Check it out and be sure to u...",
        time: "Apr 26",
        read: false
    },
    {
        id: "economist-brands",
        sender: "The Economist Today",
        subject: "Millennial brands have lost their mojo",
        snippet: "Also: How Chinese satellites have boosted Iran&rsquo;s war effort The Economist April 25th 2026 The Economist Today Our best journalism, h...",
        time: "Apr 26",
        read: false
    },
    {
        id: "chatgpt-login-396321",
        sender: "noreply",
        count: "11",
        subject: "Your temporary ChatGPT login code",
        snippet: "Enter this temporary verification code to continue: 396321 If you were not trying to log in to ChatGPT, please reset your password. Best, ...",
        time: "Apr 25",
        read: false
    },
    {
        id: "github-key",
        sender: "GitHub",
        subject: "[GitHub] A new SSH authentication public key was added to your account",
        snippet: "The following SSH key was added to your account: ramly-pc-ramly SHA256:BCHMvykoZn+nrmEr...",
        time: "Apr 25",
        read: false
    }
];

const state: AppState = {
    activeRail: "mail",
    activeFolder: "inbox",
    openEmailId: window.location.hash === "#open-email" ? "chatgpt-login-745860" : null,
    selectedIds: new Set<string>(),
    starredIds: new Set<string>(),
    readIds: new Set<string>(emails.filter((email) => email.read).map((email) => email.id)),
    menu: null,
    status: "Active",
    sidePanel: null,
    compose: null,
    toast: null,
    categoriesExpanded: true,
    moreExpanded: true,
    sidebarCollapsed: false
};

const appRoot = document.getElementById("app");
let toastTimer: number | undefined;

if (!appRoot) {
    throw new Error("Missing #app root");
}

const app = appRoot;

function icon(name: string, fill = false): string {
    return `<span class="material-symbols-outlined${fill ? " fill" : ""}">${name}</span>`;
}

function selectedClass(value: boolean): string {
    return value ? " active" : "";
}

function currentEmail(): Email {
    return emails.find((email) => email.id === state.openEmailId) ?? emails[0];
}

function visibleEmails(): Email[] {
    if (state.activeFolder === "starred") {
        return emails.filter((email) => state.starredIds.has(email.id));
    }

    if (state.activeFolder === "drafts") {
        return emails.filter((email) => email.sender === "npm" || email.sender === "OpenAI").slice(0, 11);
    }

    return emails;
}

function unreadClass(email: Email): "read" | "unread" {
    return state.readIds.has(email.id) ? "read" : "unread";
}

function renderRail(): string {
    const rails: Array<{ id: RailId; icon: string; label: string; badge?: string }> = [
        { id: "mail", icon: "mail", label: "Mail", badge: "99+" },
        { id: "chat", icon: "chat_bubble", label: "Chat" },
        { id: "meet", icon: "videocam", label: "Meet" }
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
                <input class="search-input" type="search" placeholder="Search mail" aria-label="Search mail">
                ${icon("tune", false)}
            </label>
            <div class="top-actions">
                <button class="icon-button top-icon" aria-label="Help" data-action="toggle-menu" data-menu="help">${icon("help")}</button>
                <button class="icon-button top-icon" aria-label="Settings" data-action="toggle-menu" data-menu="settings">${icon("settings")}</button>
                <button class="icon-button top-icon sparkle-icon" aria-label="Gemini" data-action="toast" data-message="Gemini is visual only">${icon("auto_awesome", true)}</button>
                <button class="icon-button top-icon" aria-label="Google apps" data-action="toggle-menu" data-menu="apps">${icon("apps", true)}</button>
                <button class="account-chip" aria-label="Google account" data-action="toggle-menu" data-menu="profile">
                    <span class="profile-avatar" aria-hidden="true">
                        <span class="avatar-face"></span>
                    </span>
                </button>
            </div>
        </header>
    `;
}

function renderFolder(id: FolderId, glyph: string, label: string, count = "", className = ""): string {
    const active = state.activeFolder === id;
    return `
        <button class="folder ${className}${active ? " active" : ""}" data-action="set-folder" data-folder="${id}">
            ${icon(glyph, active)}
            <span>${label}</span>
            ${count ? `<strong class="${id === "drafts" ? "muted-count" : ""}">${count}</strong>` : ""}
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
                ${renderFolder("inbox", "inbox", "Inbox", "3,145")}
                ${renderFolder("starred", "star", "Starred")}
                ${renderFolder("snoozed", "schedule", "Snoozed")}
                ${renderFolder("sent", "send", "Sent")}
                ${renderFolder("drafts", "draft", "Drafts", "11")}
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
        </aside>
    `;
}

function renderToolbar(): string {
    const allVisibleSelected = visibleEmails().length > 0 && visibleEmails().every((email) => state.selectedIds.has(email.id));
    const hasSelected = state.selectedIds.size > 0;

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
                <span class="range-text">${hasSelected ? `${state.selectedIds.size} selected` : "1&ndash;50 of 3,893"}</span>
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

function renderEmailRow(email: Email): string {
    const selected = state.selectedIds.has(email.id);
    const starred = state.starredIds.has(email.id);
    const open = state.openEmailId === email.id;
    const rowClasses = [
        "email-row",
        unreadClass(email),
        email.highlighted ? "highlighted" : "",
        selected ? "selected" : "",
        open ? "opened" : ""
    ].filter(Boolean).join(" ");

    return `
        <article class="${rowClasses}" data-email-row data-email-id="${email.id}">
            <div class="row-actions">
                <button class="row-check action-button" aria-label="${selected ? "Deselect" : "Select"} ${email.subject}" data-action="toggle-email-select" data-email-id="${email.id}">
                    <span class="checkbox${selected ? " checked" : ""}"></span>
                </button>
                <button class="star-button action-button${starred ? " starred" : ""}" aria-label="${starred ? "Unstar" : "Star"} ${email.subject}" data-action="toggle-star" data-email-id="${email.id}">
                    ${icon("star", starred)}
                </button>
            </div>
            <div class="sender">${email.sender}${email.count ? ` <span>${email.count}</span>` : ""}</div>
            <div class="message">
                <span class="subject">${email.subject}</span>
                <span class="snippet">- ${email.snippet}</span>
            </div>
            <time>${email.time}</time>
        </article>
    `;
}

function renderInbox(): string {
    const rows = visibleEmails();
    return `
        <main class="inbox-card">
            ${renderToolbar()}
            <section class="email-list" aria-label="Inbox emails">
                ${rows.length ? rows.map(renderEmailRow).join("") : renderEmptyFolder()}
            </section>
        </main>
    `;
}

function renderEmptyFolder(): string {
    return `
        <div class="empty-folder">
            ${icon("inbox")}
            <p>No messages here</p>
        </div>
    `;
}

function renderThread(): string {
    const email = currentEmail();
    const starred = state.starredIds.has(email.id);

    return `
        <main class="thread-card" id="thread-view" aria-label="Opened email thread" aria-hidden="${state.openEmailId ? "false" : "true"}">
            <div class="thread-toolbar">
                <button class="icon-button thread-back" aria-label="Back to inbox" data-action="close-email">${icon("arrow_back")}</button>
                <button class="icon-button thread-tool" aria-label="Archive" data-action="thread-action" data-message="Archived visually">${icon("archive")}</button>
                <button class="icon-button thread-tool" aria-label="Report spam" data-action="thread-action" data-message="Reported visually">${icon("report")}</button>
                <button class="icon-button thread-tool" aria-label="Delete" data-action="thread-action" data-message="Deleted visually">${icon("delete")}</button>
                <span class="thread-divider"></span>
                <button class="icon-button thread-tool" aria-label="Mark unread" data-action="mark-open-unread">${icon("mail")}</button>
                <button class="icon-button thread-tool" aria-label="Snooze" data-action="thread-action" data-message="Snoozed visually">${icon("schedule")}</button>
                <button class="icon-button thread-tool" aria-label="Add to tasks" data-action="thread-action" data-message="Added to tasks visually">${icon("add_task")}</button>
                <span class="thread-divider"></span>
                <button class="icon-button thread-tool" aria-label="Move" data-action="thread-action" data-message="Move menu is visual only">${icon("drive_file_move")}</button>
                <button class="icon-button thread-tool" aria-label="Label" data-action="thread-action" data-message="Label menu is visual only">${icon("label")}</button>
                <button class="icon-button thread-tool" aria-label="More" data-action="toggle-menu" data-menu="threadMore">${icon("more_vert")}</button>
            </div>
            <section class="thread-content">
                <div class="thread-heading">
                    <h1>${email.subject}</h1>
                    <span class="thread-label">Inbox <span>x</span></span>
                    <div class="thread-heading-actions">
                        <button class="icon-button" aria-label="Print" data-action="toast" data-message="Print preview is visual only">${icon("print")}</button>
                        <button class="icon-button" aria-label="Open in new window" data-action="toast" data-message="Pop-out window is visual only">${icon("open_in_new")}</button>
                    </div>
                </div>
                <article class="thread-message first-message">
                    <div class="thread-avatar empty-avatar">${icon("person", true)}</div>
                    <div class="thread-message-main">
                        <header class="message-header">
                            <div>
                                <div class="message-sender">noreply</div>
                                <div class="message-recipient">to me ${icon("arrow_drop_down")}</div>
                            </div>
                            <div class="message-meta">
                                <span>9:43 AM (10 minutes ago)</span>
                                <button class="icon-button tiny-icon${starred ? " starred" : ""}" aria-label="Star" data-action="toggle-star" data-email-id="${email.id}">${icon("star", starred)}</button>
                                <button class="icon-button tiny-icon" aria-label="Reply" data-action="open-compose" data-compose-mode="reply">${icon("reply")}</button>
                                <button class="icon-button tiny-icon" aria-label="More" data-action="toggle-menu" data-menu="threadMore">${icon("more_vert")}</button>
                            </div>
                        </header>
                        <div class="message-body">
                            <p>Hi there,</p>
                            <p>We noticed a suspicious log-in on your account.</p>
                            <p>To continue, use the temporary verification code below:</p>
                            <p class="verification-code">745860</p>
                            <p>This code will expire in 10 minutes.</p>
                            <p>If you didn&rsquo;t try to log in, please secure your account and contact support.</p>
                            <p>Thanks,<br>The ChatGPT Team</p>
                        </div>
                    </div>
                </article>
                <article class="thread-message reply-message">
                    <div class="thread-avatar face-avatar" aria-hidden="true"></div>
                    <div class="thread-message-main">
                        <header class="message-header compact">
                            <div>
                                <div class="message-sender">me</div>
                                <div class="message-recipient">to noreply ${icon("arrow_drop_down")}</div>
                            </div>
                            <div class="message-meta">
                                <span>9:46 AM (7 minutes ago)</span>
                                <button class="icon-button tiny-icon" aria-label="Star">${icon("star")}</button>
                                <button class="icon-button tiny-icon" aria-label="Reply" data-action="open-compose" data-compose-mode="reply">${icon("reply")}</button>
                                <button class="icon-button tiny-icon" aria-label="More" data-action="toggle-menu" data-menu="threadMore">${icon("more_vert")}</button>
                            </div>
                        </header>
                        <p class="short-reply">Thanks! I didn&rsquo;t request this. I&rsquo;ll secure my account now.</p>
                    </div>
                </article>
                <article class="thread-message reply-message final-reply">
                    <div class="thread-avatar empty-avatar">${icon("person", true)}</div>
                    <div class="thread-message-main">
                        <header class="message-header compact">
                            <div>
                                <div class="message-sender">noreply</div>
                                <div class="message-recipient">to me ${icon("arrow_drop_down")}</div>
                            </div>
                            <div class="message-meta">
                                <span>9:48 AM (7 minutes ago)</span>
                                <button class="icon-button tiny-icon" aria-label="Star">${icon("star")}</button>
                                <button class="icon-button tiny-icon" aria-label="Reply" data-action="open-compose" data-compose-mode="reply">${icon("reply")}</button>
                                <button class="icon-button tiny-icon" aria-label="More" data-action="toggle-menu" data-menu="threadMore">${icon("more_vert")}</button>
                            </div>
                        </header>
                        <p class="short-reply multiline">You&rsquo;re welcome! If you need any further assistance, feel free to reach out.<br><br>Stay safe,<br>The ChatGPT Team</p>
                    </div>
                </article>
                <div class="thread-footer-actions">
                    <button class="reply-pill" data-action="open-compose" data-compose-mode="reply">${icon("reply")}Reply</button>
                    <button class="reply-pill wide" data-action="open-compose" data-compose-mode="replyAll">${icon("reply_all")}Reply all</button>
                    <button class="reply-pill wide" data-action="open-compose" data-compose-mode="forward">${icon("forward")}Forward</button>
                    <button class="round-reaction" aria-label="Add reaction" data-action="toast" data-message="Reaction added visually">${icon("sentiment_satisfied")}</button>
                </div>
            </section>
        </main>
    `;
}

function renderRightRail(): string {
    const items: Array<{ id: Exclude<SidePanelId, null>; label: string; img?: string; cls?: string }> = [
        { id: "calendar", label: "Calendar", img: "https://www.gstatic.com/companion/icon_assets/calendar_2020q4_2x.png" },
        { id: "keep", label: "Keep", img: "https://www.gstatic.com/companion/icon_assets/keep_2020q4v3_2x.png" },
        { id: "tasks", label: "Tasks", img: "https://www.gstatic.com/companion/icon_assets/tasks_2021_2x.png" },
        { id: "contacts", label: "Contacts", img: "https://www.gstatic.com/companion/icon_assets/contacts_2022_2x.png" },
        { id: "gemini", label: "Gemini", cls: "gemini-mark" }
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

    const titles: Record<Exclude<SidePanelId, null>, string> = {
        calendar: "Calendar",
        keep: "Keep",
        tasks: "Tasks",
        contacts: "Contacts",
        gemini: "Gemini"
    };
    const icons: Record<Exclude<SidePanelId, null>, string> = {
        calendar: "event",
        keep: "lightbulb",
        tasks: "check_circle",
        contacts: "person",
        gemini: ""
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

function renderCompose(): string {
    if (!state.compose) {
        return "";
    }

    const cls = [
        "compose-window",
        state.compose.minimized ? "minimized" : "",
        state.compose.expanded ? "expanded" : ""
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
                    <input value="${state.compose.to}" aria-label="To">
                </label>
                <label class="compose-line">
                    <input value="${state.compose.subject}" aria-label="Subject">
                </label>
                <div class="compose-body" contenteditable="true" aria-label="Message body">${state.compose.mode === "new" ? "" : "<br><br>"}</div>
                <footer class="compose-footer">
                    <button class="send-button" data-action="send-compose">Send</button>
                    <button class="icon-button" aria-label="Formatting">${icon("format_color_text")}</button>
                    <button class="icon-button" aria-label="Attach">${icon("attach_file")}</button>
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

    const menuContent: Record<Exclude<MenuId, null>, string> = {
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
            <strong>admin3@student.tarc.edu.my</strong>
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
            <button data-action="thread-action" data-message="Filtered visually">Filter messages like this</button>
            <button data-action="thread-action" data-message="Printed visually">Print all</button>
        `
    };

    return `<div class="popover ${state.menu}-popover" data-menu-root>${menuContent[state.menu]}</div>`;
}

function renderToast(): string {
    return state.toast ? `<div class="toast">${state.toast}</div>` : "";
}

function renderShell(): string {
    const shellClasses = [
        "app-shell",
        state.openEmailId ? "mail-open" : "",
        state.sidebarCollapsed ? "sidebar-collapsed" : ""
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
    }, 1800);
}

function openEmail(emailId: string): void {
    state.openEmailId = emailId;
    state.activeFolder = "inbox";
    state.selectedIds.clear();
    state.readIds.add(emailId);
    state.menu = null;
    history.replaceState(null, "", "#open-email");
    render();
}

function closeEmail(): void {
    state.openEmailId = null;
    state.menu = null;
    if (window.location.hash === "#open-email") {
        history.replaceState(null, "", window.location.pathname);
    }
    render();
}

function setFolder(folder: FolderId): void {
    state.activeFolder = folder;
    state.menu = null;
    if (folder !== "inbox") {
        state.openEmailId = null;
    }
    render();
}

function toggleSelectAll(): void {
    const rows = visibleEmails();
    const allSelected = rows.length > 0 && rows.every((email) => state.selectedIds.has(email.id));
    if (allSelected) {
        rows.forEach((email) => state.selectedIds.delete(email.id));
    } else {
        rows.forEach((email) => state.selectedIds.add(email.id));
    }
    render();
}

function openCompose(mode: ComposeMode): void {
    const email = currentEmail();
    const to = mode === "new" ? "" : "noreply@tm.openai.com";
    const prefix = mode === "forward" ? "Fwd: " : mode === "new" ? "" : "Re: ";
    state.compose = {
        mode,
        minimized: false,
        expanded: false,
        to,
        subject: `${prefix}${mode === "new" ? "" : email.subject.replace(/&rsquo;/g, "'")}`
    };
    state.menu = null;
    render();
}

function handleAction(target: HTMLElement): void {
    const action = target.dataset.action;

    switch (action) {
        case "toggle-menu": {
            const menu = target.dataset.menu as Exclude<MenuId, null>;
            state.menu = state.menu === menu ? null : menu;
            render();
            return;
        }
        case "toggle-sidebar": {
            state.sidebarCollapsed = !state.sidebarCollapsed;
            state.menu = null;
            render();
            return;
        }
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
        case "set-folder": {
            setFolder(target.dataset.folder as FolderId);
            return;
        }
        case "toggle-categories": {
            state.categoriesExpanded = !state.categoriesExpanded;
            state.activeFolder = "categories";
            state.openEmailId = null;
            render();
            return;
        }
        case "toggle-more": {
            state.moreExpanded = !state.moreExpanded;
            state.activeFolder = "more";
            state.openEmailId = null;
            render();
            return;
        }
        case "toggle-email-select": {
            const id = target.dataset.emailId;
            if (id && state.selectedIds.has(id)) {
                state.selectedIds.delete(id);
            } else if (id) {
                state.selectedIds.add(id);
            }
            render();
            return;
        }
        case "toggle-select-all": {
            toggleSelectAll();
            return;
        }
        case "toggle-star": {
            const id = target.dataset.emailId;
            if (id && state.starredIds.has(id)) {
                state.starredIds.delete(id);
            } else if (id) {
                state.starredIds.add(id);
            }
            render();
            return;
        }
        case "refresh": {
            showToast("Inbox refreshed");
            return;
        }
        case "archive-selected": {
            const count = state.selectedIds.size;
            state.selectedIds.clear();
            showToast(count ? `${count} conversation${count === 1 ? "" : "s"} archived visually` : "Select conversations first");
            return;
        }
        case "mark-selected-read": {
            state.selectedIds.forEach((id) => state.readIds.add(id));
            showToast(state.selectedIds.size ? "Marked as read" : "Select conversations first");
            render();
            return;
        }
        case "close-email": {
            closeEmail();
            return;
        }
        case "mark-open-unread": {
            if (state.openEmailId) {
                state.readIds.delete(state.openEmailId);
                showToast("Marked unread");
            }
            return;
        }
        case "thread-action": {
            showToast(target.dataset.message ?? "Action applied visually");
            return;
        }
        case "open-compose": {
            openCompose((target.dataset.composeMode as ComposeMode | undefined) ?? "new");
            return;
        }
        case "toggle-compose-minimized": {
            if (state.compose) {
                state.compose.minimized = !state.compose.minimized;
            }
            render();
            return;
        }
        case "toggle-compose-expanded": {
            if (state.compose) {
                state.compose.expanded = !state.compose.expanded;
            }
            render();
            return;
        }
        case "close-compose": {
            state.compose = null;
            render();
            return;
        }
        case "send-compose": {
            state.compose = null;
            showToast("Message sent visually");
            return;
        }
        case "toggle-side-panel": {
            const panel = target.dataset.sidePanel as SidePanelId | "none";
            state.sidePanel = panel === "none" || state.sidePanel === panel ? null : panel;
            state.menu = null;
            render();
            return;
        }
        case "close-side-panel": {
            state.sidePanel = null;
            state.menu = null;
            render();
            return;
        }
        case "toast": {
            showToast(target.dataset.message ?? "Action applied visually");
            return;
        }
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
        handleAction(actionTarget);
        return;
    }

    const row = target.closest("[data-email-row]") as HTMLElement | null;
    if (row?.dataset.emailId) {
        openEmail(row.dataset.emailId);
        return;
    }

    if (state.menu && !target.closest("[data-menu-root]")) {
        state.menu = null;
        render();
    }
});

window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
        state.menu = null;
        if (state.compose?.expanded) {
            state.compose.expanded = false;
        } else if (state.sidePanel) {
            state.sidePanel = null;
        } else if (state.openEmailId) {
            state.openEmailId = null;
        }
        render();
    }
});

render();
