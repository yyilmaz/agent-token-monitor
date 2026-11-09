# 0019. Bootstrap 6 dashboard presentation

- Status: Accepted
- Date: 2026-11-09
- Requirements: R-14, R-25, R-26, R-30, R-31, R-33

## Context

The dashboard needs consistent navigation, layout and controls across all views in light and dark modes. ADR 0005 defines the single-page TypeScript frontend.

## Decision

- Pin Bootstrap to [6.0.0-alpha.1](https://github.com/twbs/bootstrap/releases/tag/v6.0.0-alpha.1). Vendor the release stylesheet and drawer modules with their license, and serve them through relative paths (R-14).
- Use the [Bootstrap Navbar](https://getbootstrap.com/docs/6.0/components/navbar/) for the existing top navigation. Keep the existing link labels, order, routes, and active-page semantics. Verify keyboard navigation and the navbar drawer at narrow widths.
- Use [Bootstrap color modes](https://getbootstrap.com/docs/6.0/customize/color-modes/). The standalone dashboard follows system appearance until the navbar theme button sets an explicit light or dark preference in browser storage. Apply the theme through shared CSS variables.
- Use Bootstrap cards, responsive tables, badges, form controls, button groups, accordions, popovers, progress styling and layout utilities throughout the dashboard. Use native details for accordion state and native popovers so column help stays visible outside scrollable tables. Keep native progress values and use uPlot and SVG for charts.
- Limit changes to presentation. Preserve all dashboard copy, metrics, table columns, data, and chart series.

## Alternatives considered

Extending the existing CSS would keep the current dependency set, but would require maintaining our own responsive navigation. Bootstrap 5.3 offers stable color modes, while this proposal targets the requested Bootstrap 6 navbar.

## VS Code compatibility

Load vendored assets as Webview resources under its content security policy. Map the shared theme variables to VS Code light, dark, and high-contrast colors. Verify the pinned navbar and its drawer in the Webview without changes to adapters, analysis, or routing.

## Consequences

Bootstrap 6 is an alpha release, so later versions may change component markup or styles. Pinning the release makes rendering reproducible. Verify both themes and narrow layouts before upgrading.
