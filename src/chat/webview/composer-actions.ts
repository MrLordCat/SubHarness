import { useCallback } from "preact/hooks";
import type { ChatAttachment } from "../shared/protocol";
import { postMessage } from "./api";
import type { ChatStore } from "./store";

/** Composer actions shared by the message composer and the edit composer. */
export function useComposerActions(store: ChatStore) {
	const onStop = useCallback(() => postMessage({ type: "stop" }), []);
	const onSelectModel = useCallback((modelId: string) => postMessage({ type: "selectModel", modelId }), []);
	const onSelectThinking = useCallback((value: string) => postMessage({ type: "selectThinking", value }), []);
	const onRefreshQuota = useCallback(() => postMessage({ type: "refreshQuota" }), []);
	const onSetToolsEnabled = useCallback((names: string[], enabled: boolean) => {
		store.setToolsEnabled(names, enabled);
		postMessage({ type: "setToolsEnabled", names, enabled });
	}, [store]);
	const onPickAttachments = useCallback(() => postMessage({ type: "pickAttachments" }), []);
	const onAddAttachments = useCallback((uris: string[]) => postMessage({ type: "addAttachments", uris }), []);
	const onOpenAttachment = useCallback((attachment: ChatAttachment) => postMessage({ type: "openAttachment", attachment }), []);
	const onRemoveAttachment = useCallback((id: string) => store.removeAttachment(id), [store]);
	return {
		onStop,
		onSelectModel,
		onSelectThinking,
		onRefreshQuota,
		onSetToolsEnabled,
		onPickAttachments,
		onAddAttachments,
		onOpenAttachment,
		onRemoveAttachment,
	};
}
