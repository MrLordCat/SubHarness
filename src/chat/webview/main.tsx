import { render } from "preact";

import { App } from "./app";
import { postMessage } from "./api";
import { ChatStore } from "./store";
import "./chat.css";

const store = new ChatStore();
window.addEventListener("message", store.receive);

const root = document.getElementById("root");
if (root) {
	render(<App store={store} />, root);
}

postMessage({ type: "ready" });
