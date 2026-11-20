import { render } from "preact";

import { App } from "./app";
import { postMessage } from "./api";
import { ChatStore } from "./store";
import "./chat.css";

const store = new ChatStore();
window.addEventListener("message", store.receive);
// A reload or a closed view must not lose the last keystrokes of a draft.
window.addEventListener("pagehide", store.flushDraft);
document.addEventListener("visibilitychange", () => {
	if (document.visibilityState === "hidden") {
		store.flushDraft();
	}
});

const root = document.getElementById("root");
if (root) {
	render(<App store={store} />, root);
}

postMessage({ type: "ready" });
