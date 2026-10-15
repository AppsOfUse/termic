// The ONE type scale for menu rows, shared by the dropdown (Dropdown.tsx)
// and right-click (ContextMenu.tsx) primitives. They used to hard-code
// their own sizes, 14px and 13px, so the sidebar's View options dropdown
// and the project's right-click menu, opened side by side, did not match.
// Change a menu's text size here, never in one primitive.

/** A row (item or submenu trigger): text size and box. */
export const MENU_ROW = "rounded-sm px-2 py-1.5 text-[13px]";

/** A section label inside a menu. */
export const MENU_LABEL = "px-2 py-1 text-[11px] uppercase tracking-wider text-[var(--color-fg-faint)]";
