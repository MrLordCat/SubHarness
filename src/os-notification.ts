import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Runs a notification command without a shell. */
export type OsNotificationRunner = (command: string, args: string[]) => Promise<void>;

const defaultRunner: OsNotificationRunner = (command, args) => new Promise((resolve, reject) => {
	execFile(command, args, { windowsHide: true, timeout: 15_000 }, error => {
		if (error) {
			reject(error);
		} else {
			resolve();
		}
	});
});

/**
 * Builds a platform notification command without invoking a shell.
 * `launch` is a URI a click on a Windows toast opens; without it a click starts the app afresh.
 */
export function osNotificationCommand(platform: NodeJS.Platform, title: string, body: string, appId?: string, launch?: string): { command: string; args: string[] } | undefined {
	if (platform === "win32") {
		const xml = (value: string): string => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
		const literal = (value: string): string => "'" + value.replace(/'/g, "''") + "'";
		const activation = launch ? ` activationType="protocol" launch="${xml(launch)}"` : "";
		const toastXml = `<toast${activation}><visual><binding template="ToastGeneric"><text>${xml(title)}</text><text>${xml(body)}</text></binding></visual></toast>`;
		const id = appId ?? "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";
		const script = `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null\n[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null\n$xml = New-Object Windows.Data.Xml.Dom.XmlDocument\n$xml.LoadXml(${literal(toastXml)})\n$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)\n$appId = ${literal(id)}\n[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)`;
		return { command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")] };
	}
	if (platform === "darwin") {
		const quote = (value: string): string => '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
		return { command: "osascript", args: ["-e", `display notification ${quote(body)} with title ${quote(title)}`] };
	}
	if (["linux", "freebsd", "openbsd", "sunos", "aix"].includes(platform)) {
		return { command: "notify-send", args: ["--app-name=Visual Studio Code", title, body] };
	}
	return undefined;
}

/** Reads VS Code's Windows toast identity from its product metadata. */
export function vscodeToastAppId(appRoot: string): string | undefined {
	try {
		const product: unknown = JSON.parse(readFileSync(join(appRoot, "product.json"), "utf8"));
		if (product && typeof product === "object" && "win32AppUserModelId" in product && typeof product.win32AppUserModelId === "string") {
			return product.win32AppUserModelId;
		}
	} catch {
		return undefined;
	}
	return undefined;
}

/** Creates a fire-and-forget notifier with short-lived duplicate suppression. */
export function createOsNotifier(options: { platform?: NodeJS.Platform; appId?: string; run?: OsNotificationRunner; now?: () => number; log?: (event: string, data: Record<string, unknown>) => void }): (title: string, body: string, launch?: string) => void {
	const recent = new Map<string, number>();
	// A broken notifier would fail on every call; the first failure is enough in the log.
	let failureLogged = false;
	return (title, body, launch) => {
		const command = osNotificationCommand(options.platform ?? process.platform, title, body, options.appId, launch);
		if (!command) {
			return;
		}
		const now = (options.now ?? Date.now)();
		for (const [key, time] of recent) {
			if (now - time >= 5000) {
				recent.delete(key);
			}
		}
		const key = JSON.stringify([title, body]);
		if (recent.has(key)) {
			return;
		}
		recent.set(key, now);
		void Promise.resolve().then(() => (options.run ?? defaultRunner)(command.command, command.args)).catch((error: unknown) => {
			if (!failureLogged) {
				failureLogged = true;
				options.log?.("chat.os_notification.failed", { message: error instanceof Error ? error.message : String(error) });
			}
		});
	};
}
