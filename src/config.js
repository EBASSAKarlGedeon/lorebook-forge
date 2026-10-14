export const extensionName = "lorebook-forge";
export const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

export const defaultSettings = {
    searxngUrl: "http://localhost:8888",
    drafts: [], // entry drafts awaiting commit to a lorebook
    wizard: {
        canonRules: "", // free-text ground-truth policy, sent with every AI call
        sources: [],    // [{id, title, text, addedAt}] pasted source material
    },
    draftsPanelWidth: 300, // persisted drag-resize width (px)
};
