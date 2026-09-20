export type PaneToggleUi = {
  open: () => Promise<unknown>;
  close: () => Promise<unknown>;
};

export async function togglePane(isOpen: boolean, ui: PaneToggleUi): Promise<boolean> {
  if (isOpen) {
    await ui.close();
    return false;
  }
  await ui.open();
  return true;
}
