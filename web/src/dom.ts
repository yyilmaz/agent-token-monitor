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

/** Bootstrap 6 accordion built on native details, so expanded state survives polling (ADR 0019). */
export function disclosure(label: string, ...content: Child[]): HTMLElement {
  return h(
    "div",
    { class: "accordion accordion-sm" },
    h(
      "details",
      { class: "accordion-item" },
      h(
        "summary",
        { class: "accordion-header fw-semibold gap-3" },
        label,
        svg("svg", { class: "accordion-icon", viewBox: "0 0 16 16", "aria-hidden": "true", fill: "none", stroke: "currentColor", "stroke-width": 1.5 },
          svg("path", { d: "m3 6 5 5 5-5" })),
      ),
      h("div", { class: "accordion-body" }, content),
    ),
  );
}

let nextColumnHelp = 0;

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
        set = new Set(columns.filter((c) => parsed.includes(c.title)).map((c) => c.title))
        if (set.size === columns.length) set.clear();
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
  if (rows.length === 0) return h("p", { class: "card p-5 muted mb-0" }, empty);
  const container = h("div", {});

  const hidden = tableId === undefined ? new Set<string>() : getHiddenSet(tableId, columns);
  const tablePanel = h("div", {
    class: tableId === undefined ? "table-responsive table-card" : `table-responsive table-card table-${tableId}`,
    role: "region",
    tabindex: "0",
  });

  const renderRows = () => {
    const activeCols = columns.filter((c) => !hidden.has(c.title));
    const scroll = tablePanel.scrollLeft;
    tablePanel.replaceChildren(
      h(
        "table",
        { class: "table table-hover align-middle text-nowrap" },
        h(
          "thead",
          {},
          h(
            "tr",
            {},
            activeCols.map((c) => {
              const helpId = c.help === undefined ? undefined : `column-help-${++nextColumnHelp}`;
              return h(
                "th",
                { scope: "col", class: c.numeric ? "num" : "", ...(c.help === undefined ? {} : { title: c.help }) },
                c.title,
                helpId === undefined || c.help === undefined
                  ? null
                  : [
                      h("button", { class: "btn-text btn-sm col-help", type: "button", popovertarget: helpId, "aria-label": c.help }, " ⓘ"),
                      h("span", { id: helpId, class: "popover show column-popover", popover: "auto" }, h("span", { class: "popover-body d-block" }, c.help)),
                    ],
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
              activeCols.map((c) => h("td", c.numeric ? { class: "num", "data-label": c.title } : { "data-label": c.title }, c.cell(row))),
            );
          }),
        ),
      ),
    );
    tablePanel.scrollLeft = scroll;
  };

  if (tableId !== undefined) {
    // Bootstrap Menu styling with native popover dismissal and checkbox semantics (R-31, ADR 0019).
    const menuId = `columns-${tableId}`;
    const trigger = h("button", {
      id: `${menuId}-toggle`, class: "btn btn-sm", type: "button", popovertarget: menuId,
    }, "Columns", svg("svg", { width: 12, height: 12, viewBox: "0 0 12 12", "aria-hidden": "true", fill: "none", stroke: "currentColor" },
      svg("path", { d: "m2 4 4 4 4-4" })));
    const reset = h("button", { id: `${menuId}-reset`, class: "menu-item", type: "button" }, "Show all");
    const checks = columns.map((column, index) => {
      const input = h("input", { id: `${menuId}-${index}`, type: "checkbox", class: "m-0" });
      input.addEventListener("change", () => {
        if (input.checked) hidden.delete(column.title);
        else hidden.add(column.title);
        update();
      });
      return { input, title: column.title };
    });
    const syncControls = () => {
      const visibleCount = columns.length - hidden.size;
      checks.forEach(({ input, title }) => {
        input.checked = !hidden.has(title);
        input.disabled = input.checked && visibleCount === 1;
      });
      reset.disabled = hidden.size === 0;
    };
    const update = () => {
      saveHiddenSet(tableId, hidden);
      syncControls();
      renderRows();
    };
    reset.addEventListener("click", () => {
      hidden.clear();
      update();
      checks[0]?.input.focus();
    });
    syncControls();
    container.append(h(
      "div",
      { class: "d-flex justify-content-end mb-3" },
      trigger,
      h("div", { id: menuId, class: "menu column-menu", popover: "auto", role: "group", "aria-labelledby": trigger.id },
        checks.map(({ input, title }) => h("label", { class: "menu-item" }, input, title)),
        h("hr", { class: "menu-divider" }),
        reset,
      ),
    ));
  }

  renderRows();
  container.append(tablePanel);
  return container;
}

export function card(label: string, value: Child, ...notes: Child[]): HTMLElement {
  return h(
    "div",
    { class: "card p-5" },
    h("div", { class: "label" }, label),
    h("div", { class: "value" }, value),
    notes.map((n) => (n instanceof Element && n.classList.contains("mini-viz") ? n : h("div", { class: "muted small" }, n))),
  );
}

export function sessionLink(sessionId: string, text: string = sessionId): HTMLElement {
  return h("a", { href: `#session/${encodeURIComponent(sessionId)}`, title: sessionId }, text);
}
