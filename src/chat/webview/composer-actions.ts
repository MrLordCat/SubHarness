import { useCallback } from "preact/hooks";
import type { ChatAttachment, ChatAttachmentTarget, ChatPastedFile } from "../shared/protocol";
import { postMessage } from "./api";
import type { ChatStore } from "./store";

/** Composer actions shared by the message composer and the edit composer. */
export function useComposerActions(store: ChatStore, target: ChatAttachmentTarget) {
	const onStop = useCallback(() => postMessage({ type: "stop" }), []);
	const onSelectModel = useCallback((modelId: string) => postMessage({ type: "selectModel", modelId }), []);
	const onSelectThinking = useCallback((value: string) => postMessage({ type: "selectThinking", value }), []);
	const onRefreshQuota = useCallback(() => postMessage({ type: "refreshQuota" }), []);
	const onSetToolsEnabled = useCallback((names: string[], enabled: boolean) => {
		store.setToolsEnabled(names, enabled);
		postMessage({ type: "setToolsEnabled", names, enabled });
	}, [store]);
	const onPickAttachments = useCallback(() => postMessage({ type: "pickAttachments", target }), [target]);
	const onAddAttachments = useCallback((uris: string[]) => postMessage({ type: "addAttachments", uris, target }), [target]);
	const onPasteFiles = useCallback((files: ChatPastedFile[]) => postMessage({ type: "pasteFiles", files, target }), [target]);
	const onSignIn = useCallback((provider: string) => postMessage({ type: "signIn", provider }), []);
	const onOpenAttachment = useCallback((attachment: ChatAttachment) => postMessage({ type: "openAttachment", attachment }), []);
	const onRemoveAttachment = useCallback((id: string) => store.removeAttachment(id), [store]);
	const onSetFavoriteModel = useCallback((modelId: string, favorite: boolean) => store.setFavoriteModel(modelId, favorite), [store]);
	return {
		onStop,
		onSelectModel,
		onSetFavoriteModel,
		onSelectThinking,
		onRefreshQuota,
		onSetToolsEnabled,
		onPickAttachments,
		onAddAttachments,
		onPasteFiles,
		onSignIn,
		onOpenAttachment,
		onRemoveAttachment,
	};
}
