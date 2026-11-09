// Rendering helpers. Text is always set with textContent, never as HTML, so logged values cannot inject markup.

type Child = Node | string | number | null | undefined | false;

const SVG_NS = "http://www.w3.org/2000/svg";

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Readonly<Record<string, string>> = {},
  ...children: readonly (Child | readonly Child[])[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    element.append(child instanceof Node ? child : String(child));
  }
  return element;
}

export function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attributes: Readonly<Record<string, string | number>> = {},
  ...children: readonly (Child | readonly Child[])[]
): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    element.append(child instanceof Node ? child : String(child));
  }
  return element;
}

export interface Column<R> {
  readonly title: string;
  readonly help?: string;
  readonly numeric?: boolean;
  readonly defaultHidden?: boolean;
  readonly cell: (row: R) => Child;
}

const hiddenColumnsByTable = new Map<string, Set<string>>();

function getHiddenSet(tableId: string, columns: readonly { readonly title: string; readonly defaultHidden?: boolean }[]): Set<string> {
  let set = hiddenColumnsByTable.get(tableId);
  if (set !== undefined) return set;
  const storageKey = `atm.hiddenCols.${tableId}`;
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (raw !== null) {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        set = new Set(parsed.filter((x): x is string => typeof x === "string"));
        hiddenColumnsByTable.set(tableId, set);
        return set;
      }
    }
  } catch {
    // Ignore storage restriction in sandboxed webviews (R-26).
  }
  set = new Set(columns.filter((c) => c.defaultHidden).map((c) => c.title));
  hiddenColumnsByTable.set(tableId, set);
  return set;
}

function saveHiddenSet(tableId: string, set: ReadonlySet<string>): void {
  try {
    window.localStorage.setItem(`atm.hiddenCols.${tableId}`, JSON.stringify([...set]));
  } catch {
    // Ignore storage restriction in sandboxed webviews (R-26).
  }
}

export function table<R>(
  columns: readonly Column<R>[],
  rows: readonly R[],
  empty = "Nothing to show.",
  rowClass?: (row: R) => string | null,
  tableId?: string,
): HTMLElement {
  if (rows.length === 0) return h("p", { class: "muted" }, empty);
  const container = h("div", {});

  const renderInner = () => {
    container.replaceChildren();
    const hidden = tableId === undefined ? new Set<string>() : getHiddenSet(tableId, columns);
    const visibleCols = columns.filter((c) => !hidden.has(c.title));
    const activeCols = visibleCols.length > 0 ? visibleCols : columns;

    if (tableId !== undefined) {
      container.append(
        h(
          "div",
          { class: "col-toggles" },
          h("span", { class: "muted small" }, "Columns:"),
          columns.map((c) => {
            const isVisible = !hidden.has(c.title);
            const btn = h(
              "button",
              {
                type: "button",
                class: `col-toggle ${isVisible ? "active" : "off"}`,
                "aria-pressed": String(isVisible),
                title: isVisible ? `Hide "${c.title}" column` : `Show "${c.title}" column`,
              },
              c.title,
            );
            btn.addEventListener("click", () => {
              if (hidden.has(c.title)) {
                hidden.delete(c.title);
              } else if (columns.length - hidden.size > 1) {
                hidden.add(c.title);
              }
              saveHiddenSet(tableId, hidden);
              renderInner();
            });
            return btn;
          }),
          hidden.size > 0
            ? (() => {
                const resetBtn = h("button", { type: "button", class: "col-toggle reset", title: "Show all columns" }, "Show all");
                resetBtn.addEventListener("click", () => {
                  hidden.clear();
                  saveHiddenSet(tableId, hidden);
                  renderInner();
                });
                return resetBtn;
              })()
            : null,
        ),
      );
    }

    container.append(
      h(
        "div",
        { class: "table-wrap" },
        h(
          "table",
          {},
          h(
            "thead",
            {},
            h(
              "tr",
              {},
              activeCols.map((c) => {
                const cls = [c.numeric ? "num" : "", c.help !== undefined ? "has-help" : ""].filter(Boolean).join(" ");
                return h(
                  "th",
                  cls === "" ? {} : { class: cls },
                  c.title,
                  c.help === undefined
                    ? null
                    : h("span", { class: "col-help", tabindex: "0", "aria-label": c.help }, " ⓘ", h("span", { class: "col-tip" }, c.help)),
                );
              }),
            ),
          ),
          h(
            "tbody",
            {},
            rows.map((row) => {
              const cls = rowClass?.(row) ?? null;
              return h(
                "tr",
                cls === null ? {} : { class: cls },
                activeCols.map((c) => h("td", c.numeric ? { class: "num" } : {}, c.cell(row))),
              );
            }),
          ),
        ),
      ),
    );
  };

  renderInner();
  return container;
}

export function card(label: string, value: Child, ...notes: Child[]): HTMLElement {
  return h(
    "div",
    { class: "card" },
    h("div", { class: "label" }, label),
    h("div", { class: "value" }, value),
    notes.map((n) => (n instanceof Element && n.classList.contains("mini-viz") ? n : h("div", { class: "muted small" }, n))),
  );
}

export function sessionLink(sessionId: string, text: string = sessionId): HTMLElement {
  return h("a", { href: `#session/${encodeURIComponent(sessionId)}`, title: sessionId }, text);
}
