/**
 * Desktop notifications (ui/lib/notify.ts). The browser API is the one thing here that cannot be exercised
 * directly, so it is faked: what matters is the decision — available, allowed and wanted, and nothing else.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notificationState, notificationsSupported, notifyTurnDone, requestNotifications, setWantsNotifications, wantsNotifications } from "./notify.ts";

class FakeNotification {
	static permission: NotificationPermission = "granted";
	static requestPermission = vi.fn(async (): Promise<NotificationPermission> => {
		FakeNotification.permission = "granted";
		return FakeNotification.permission;
	});
	static instances: FakeNotification[] = [];

	onclick: (() => void) | null = null;
	closed = false;

	constructor(
		readonly title: string,
		readonly options: NotificationOptions,
	) {
		FakeNotification.instances.push(this);
	}

	close(): void {
		this.closed = true;
	}
}

beforeEach(() => {
	FakeNotification.permission = "granted";
	FakeNotification.requestPermission.mockClear();
	FakeNotification.instances = [];
	vi.stubGlobal("Notification", FakeNotification);
	localStorage.removeItem("flypi.notifications");
});

afterEach(() => {
	vi.unstubAllGlobals();
	localStorage.removeItem("flypi.notifications");
});

describe("desktop notifications", () => {
	it("shows a finished turn with the page's title, body and tag", () => {
		const clicked = vi.fn();
		const shown = notifyTurnDone({ title: "flypi — fix the sort", body: "the tests pass", tag: "/tmp/a.jsonl", onClick: clicked });

		expect(shown).toBeInstanceOf(FakeNotification);
		expect(FakeNotification.instances).toHaveLength(1);
		const notice = FakeNotification.instances[0]!;
		expect(notice.title).toBe("flypi — fix the sort");
		expect(notice.options).toMatchObject({ body: "the tests pass", tag: "/tmp/a.jsonl" });

		// Clicking focuses the window, opens the session, and dismisses the notice.
		notice.onclick?.();
		expect(clicked).toHaveBeenCalledOnce();
		expect(notice.closed).toBe(true);
	});

	it("says nothing when the browser has not granted permission", () => {
		FakeNotification.permission = "denied";
		expect(notifyTurnDone({ title: "t", body: "b", tag: "x" })).toBeUndefined();
		expect(FakeNotification.instances).toHaveLength(0);
	});

	it("says nothing when the user turned them off, and remembers that choice", () => {
		setWantsNotifications(false);
		expect(wantsNotifications()).toBe(false);
		expect(notifyTurnDone({ title: "t", body: "b", tag: "x" })).toBeUndefined();
		expect(FakeNotification.instances).toHaveLength(0);

		setWantsNotifications(true);
		expect(wantsNotifications()).toBe(true);
		expect(notifyTurnDone({ title: "t", body: "b", tag: "x" })).toBeDefined();
	});

	it("asks the browser once, and only while the answer is still open", async () => {
		FakeNotification.permission = "default";
		expect(await requestNotifications()).toBe("granted");
		expect(FakeNotification.requestPermission).toHaveBeenCalledOnce();

		// Already answered: the browser refuses to ask again, so neither does the page.
		FakeNotification.permission = "denied";
		expect(await requestNotifications()).toBe("denied");
		expect(FakeNotification.requestPermission).toHaveBeenCalledOnce();
	});

	it("is unsupported where the API is missing, without throwing", async () => {
		vi.stubGlobal("Notification", undefined);
		expect(notificationsSupported()).toBe(false);
		expect(notificationState()).toBe("unsupported");
		expect(await requestNotifications()).toBe("unsupported");
		expect(notifyTurnDone({ title: "t", body: "b", tag: "x" })).toBeUndefined();
	});

	it("survives a browser that refuses to store the preference", () => {
		const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new Error("storage disabled");
		});
		expect(wantsNotifications()).toBe(true);
		get.mockRestore();

		const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("storage disabled");
		});
		expect(() => setWantsNotifications(false)).not.toThrow();
		set.mockRestore();
	});
});
