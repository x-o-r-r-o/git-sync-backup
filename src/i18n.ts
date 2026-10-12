// Tiny translation layer. Follows Obsidian's interface language. English is the source of truth;
// missing keys fall back to English. See docs/TRANSLATING.md.

const en = {
	// commands
	"cmd.sync": "Sync now",
	"cmd.review": "Review changes and sync",
	"cmd.status": "Open sync status panel",
	"cmd.pull": "Pull only (download changes)",
	"cmd.push": "Back up only (upload changes)",
	"cmd.preview": "Preview sync (dry run)",
	"cmd.timeline": "Timeline: restore vault or folder to an earlier point",
	"cmd.reset": "Make this device match the repository (discard local changes)",
	"cmd.snapshot": "Create backup snapshot",
	"cmd.wizard": "Run setup wizard",
	"cmd.encryption": "End-to-end encryption: turn on or unlock",
	"cmd.freeSpace": "Free up space on this device",
	"cmd.log": "Show sync log",
	"cmd.history": "Show history of current file",
	"cmd.compare": "Compare current file with the repository",
	"cmd.recover": "Recover deleted files",
	"cmd.openRepo": "Open repository in browser",
	// ribbon / menus
	"ribbon.sync": "Sync vault",
	"ribbon.status": "Sync status",
	"menu.history": "Version history",
	"menu.compare": "Compare with repository",
	// status panel
	"health.title": "Sync status",
	"health.upToDate": "Up to date",
	"health.syncing": "Syncing…",
	"health.failed": "Last sync failed",
	"health.attention": "Needs attention",
	"health.notSynced": "Not synced yet",
	"health.notSetUp": "Not set up",
	"health.syncNow": "Sync now",
	"health.review": "Review…",
	"health.wizard": "Run setup wizard",
	"health.pending": "Pending",
	"health.editedN": "{n} file(s) edited on this device since the last sync",
	"health.noEdits": "No local edits waiting",
	"health.remoteAhead": "The repository has newer changes from another device",
	"health.remoteSame": "Nothing new in the repository",
	"health.checking": "Checking the repository…",
	"health.nextSync": "Next scheduled sync {time}",
	"health.noSchedule": "No periodic sync scheduled",
	"health.conflicts": "Conflict copies ({n})",
	"health.conflictsHint": "Both versions were kept. Compare them, keep what you need, then delete the copy.",
	"health.compare": "Compare",
	"health.open": "Open",
	"health.deleteCopy": "Delete copy",
	"health.skipped": "Skipped in last sync ({n})",
	"health.devices": "Devices",
	"health.thisDevice": "(this device)",
	"health.lastSynced": "last synced {ago}",
	"health.shared": "Shared folders",
	"health.tools": "Tools",
	"health.timeline": "Timeline & restore",
	"health.snapshot": "Snapshot now",
	"health.reset": "Make this device match the repository",
	"health.freeSpace": "Free up space",
	"health.log": "Sync log",
	"health.settings": "Settings",
	"health.openSettings": "Open settings",
	"health.tryAgain": "Try again",
	"health.enterPassphrase": "Enter passphrase",
	"health.encrypted": "end-to-end encrypted",
	// notices
	"notice.upToDate": "Vault is up to date.",
	"notice.synced": "Sync: {summary}",
	"notice.failed": "Sync failed: {error}",
	"notice.errors": "Sync finished with {n} error(s). Open the sync status panel for details.",
	"notice.conflicts": "Sync: {n} conflict(s). Both versions kept; compare them in the sync status panel.",
	"notice.busy": "A sync is running. Try again in a moment.",
	// time
	"time.never": "never",
	"time.now": "just now",
	"time.min": "{n} min ago",
	"time.hour": "{n} h ago",
	"time.day": "{n} d ago",
};

export type Key = keyof typeof en;

const zh: Partial<Record<Key, string>> = {
	"cmd.sync": "立即同步",
	"cmd.review": "查看更改并同步",
	"cmd.status": "打开同步状态面板",
	"cmd.pull": "仅拉取（下载更改）",
	"cmd.push": "仅备份（上传更改）",
	"cmd.preview": "预览同步（试运行）",
	"cmd.timeline": "时间线：将库或文件夹恢复到较早的时间点",
	"cmd.reset": "使此设备与仓库一致（放弃本地更改）",
	"cmd.snapshot": "创建备份快照",
	"cmd.wizard": "运行设置向导",
	"cmd.encryption": "端到端加密：开启或解锁",
	"cmd.freeSpace": "释放此设备上的空间",
	"cmd.log": "显示同步日志",
	"cmd.history": "显示当前文件的历史",
	"cmd.compare": "将当前文件与仓库比较",
	"cmd.recover": "恢复已删除的文件",
	"cmd.openRepo": "在浏览器中打开仓库",
	"ribbon.sync": "同步库",
	"ribbon.status": "同步状态",
	"menu.history": "版本历史",
	"menu.compare": "与仓库比较",
	"health.title": "同步状态",
	"health.upToDate": "已是最新",
	"health.syncing": "正在同步…",
	"health.failed": "上次同步失败",
	"health.attention": "需要处理",
	"health.notSynced": "尚未同步",
	"health.notSetUp": "尚未设置",
	"health.syncNow": "立即同步",
	"health.review": "查看…",
	"health.wizard": "运行设置向导",
	"health.pending": "待处理",
	"health.editedN": "自上次同步以来，此设备上有 {n} 个文件被修改",
	"health.noEdits": "没有等待同步的本地修改",
	"health.remoteAhead": "仓库中有来自其他设备的较新更改",
	"health.remoteSame": "仓库中没有新内容",
	"health.checking": "正在检查仓库…",
	"health.nextSync": "下次定时同步 {time}",
	"health.noSchedule": "未设置定时同步",
	"health.conflicts": "冲突副本（{n}）",
	"health.conflictsHint": "两个版本都已保留。比较它们，保留需要的内容，然后删除副本。",
	"health.compare": "比较",
	"health.open": "打开",
	"health.deleteCopy": "删除副本",
	"health.skipped": "上次同步跳过的文件（{n}）",
	"health.devices": "设备",
	"health.thisDevice": "（此设备）",
	"health.lastSynced": "上次同步 {ago}",
	"health.shared": "共享文件夹",
	"health.tools": "工具",
	"health.timeline": "时间线与恢复",
	"health.snapshot": "立即创建快照",
	"health.reset": "使此设备与仓库一致",
	"health.freeSpace": "释放空间",
	"health.log": "同步日志",
	"health.settings": "设置",
	"health.openSettings": "打开设置",
	"health.tryAgain": "重试",
	"health.enterPassphrase": "输入密码短语",
	"health.encrypted": "端到端加密",
	"notice.upToDate": "库已是最新。",
	"notice.synced": "同步：{summary}",
	"notice.failed": "同步失败：{error}",
	"notice.errors": "同步完成，但有 {n} 个错误。请打开同步状态面板查看详情。",
	"notice.conflicts": "同步：{n} 个冲突。两个版本都已保留，可在同步状态面板中比较。",
	"notice.busy": "正在同步，请稍后再试。",
	"time.never": "从未",
	"time.now": "刚刚",
	"time.min": "{n} 分钟前",
	"time.hour": "{n} 小时前",
	"time.day": "{n} 天前",
};

const catalogs: Record<string, Partial<Record<Key, string>>> = { zh };

function language(): string {
	try {
		return (window.localStorage.getItem("language") || "en").toLowerCase();
	} catch {
		return "en";
	}
}

/** Translate `key`, replacing {placeholders}. */
export function t(key: Key, vars: Record<string, string | number> = {}): string {
	const lang = language();
	const cat = catalogs[lang] ?? catalogs[lang.split("-")[0]];
	const s = cat?.[key] ?? en[key];
	return s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`));
}

export const LANGUAGES = ["en", ...Object.keys(catalogs)];
