/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope Public
 *
 * BC Inventory Picker Suitelet
 *
 * Opens in a popup from the Sales Order line. Shows candidate source locations
 * with on-hand / available / committed quantities. User clicks a row to select.
 * Selection is posted back to the parent SO window via window.opener.
 *
 * URL params (all required except soId):
 *   itemId          - internal ID of the SO line item
 *   qtyRequired     - decimal quantity needed (used to disable insufficient rows)
 *   destLocationId  - SO header/destination location (excluded from picker)
 *   subsidiaryId    - SO subsidiary (filters locations to same subsidiary)
 *   soId            - SO internal ID (audit only; optional)
 *   lineId          - SO line ID or line index for postMessage round-trip
 */
define(['N/search', 'N/log', 'N/runtime'], function (search, log, runtime) {

    function onRequest(context) {
        var req = context.request;
        var res = context.response;

        var itemId = req.parameters.itemId;
        var qtyRequired = parseFloat(req.parameters.qtyRequired || '0');
        var destLocationId = req.parameters.destLocationId;
        var subsidiaryId = req.parameters.subsidiaryId;
        var soId = req.parameters.soId || '';
        var lineId = req.parameters.lineId || '';

        // Basic param validation
        if (!itemId || !qtyRequired || !destLocationId || !subsidiaryId) {
            res.write({
                output: renderError('Missing required parameters. itemId, qtyRequired, destLocationId, and subsidiaryId are all required.')
            });
            return;
        }

        var rows = [];
        try {
            rows = getInventoryRows(itemId, subsidiaryId, destLocationId, qtyRequired);
        } catch (e) {
            log.error('Picker query failed', e);
            res.write({ output: renderError('Could not load inventory: ' + e.message) });
            return;
        }

        res.write({ output: renderPage(rows, itemId, qtyRequired, lineId, soId) });
    }

    /**
     * Query Inventory Balance for the item, restricted to active locations
     * in the SO's subsidiary, excluding the SO destination location.
     */
    function getInventoryRows(itemId, subsidiaryId, destLocationId, qtyRequired) {
        var filters = [
            ['item', 'anyof', itemId],
            'AND',
            ['location.subsidiary', 'anyof', subsidiaryId],
            'AND',
            ['location.isinactive', 'is', 'F']
            // 'AND',
            // ['location.includeinsupplyplanning', 'is', 'T']
        ];

        var columns = [
            search.createColumn({ name: 'location' }),
            search.createColumn({ name: 'onhand' }),
            search.createColumn({ name: 'available' }),
          //  search.createColumn({ name: 'locationonorder' }),
            search.createColumn({ name: 'invnumcommitted' })
        ];

        var rows = [];
        try {
            var s = search.create({
                type: 'inventorybalance',
                filters: filters,
                columns: columns
            });

            s.run().each(function (r) {
                var locId = r.getValue({ name: 'location' });
                var locName = r.getText({ name: 'location' });
                var onHand = parseFloat(r.getValue({ name: 'onhand' }) || '0');
                var available = parseFloat(r.getValue({ name: 'available' }) || '0');
                var committed = parseFloat(r.getValue({ name: 'invnumcommitted' }) || '0');

                var isDest = (String(locId) === String(destLocationId));
                var sufficient = (available >= qtyRequired);

                var status = 'Available';
                var disabled = false;
                if (isDest) {
                    status = 'Destination Location';
                    disabled = true;
                } else if (!sufficient) {
                    status = 'Insufficient Available Qty';
                    disabled = true;
                }

                rows.push({
                    locId: locId,
                    locName: locName,
                    onHand: onHand,
                    available: available,
                    committed: committed,
                    status: status,
                    disabled: disabled
                });
                return true;
            });
        } catch (e) {
            // If inventorybalance search type isn't available (MLI off, etc.) bubble up
            throw e;
        }

        // Sort: selectable rows first (by available desc), then disabled rows
        rows.sort(function (a, b) {
            if (a.disabled !== b.disabled) return a.disabled ? 1 : -1;
            return b.available - a.available;
        });

        return rows;
    }

    function renderPage(rows, itemId, qtyRequired, lineId, soId) {
        var rowHtml = rows.map(function (r) {
            var rowClass = r.disabled ? 'row disabled' : 'row selectable';
            var clickAttr = r.disabled
                ? ''
                : 'onclick="selectLocation(' + r.locId + ', \'' + escapeJs(r.locName) + '\')"';
            return [
                '<tr class="' + rowClass + '" ' + clickAttr + '>',
                '<td>' + escapeHtml(r.locName) + '</td>',
                '<td class="num">' + formatNum(r.onHand) + '</td>',
                '<td class="num">' + formatNum(r.available) + '</td>',
                '<td class="num">' + formatNum(r.committed) + '</td>',
                '<td>' + escapeHtml(r.status) + '</td>',
                '</tr>'
            ].join('');
        }).join('');

        if (!rowHtml) {
            rowHtml = '<tr><td colspan="5" class="empty">No locations found for this item in the current subsidiary.</td></tr>';
        }

        return [
            '<!DOCTYPE html>',
            '<html><head><meta charset="utf-8">',
            '<title>Select Source Location</title>',
            '<style>',
            '  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size: 13px; margin: 0; padding: 16px; background: #fff; color: #333; }',
            '  h2 { font-size: 15px; margin: 0 0 4px 0; color: #2b3a4a; }',
            '  .meta { color: #666; font-size: 12px; margin-bottom: 12px; }',
            '  .meta strong { color: #333; }',
            '  table { border-collapse: collapse; width: 100%; }',
            '  th { background: #f0f3f6; text-align: left; padding: 8px 10px; font-weight: 600; border-bottom: 2px solid #d4dae0; font-size: 12px; }',
            '  th.num, td.num { text-align: right; }',
            '  td { padding: 8px 10px; border-bottom: 1px solid #eaecef; }',
            '  tr.selectable { cursor: pointer; }',
            '  tr.selectable:hover { background: #eaf4ff; }',
            '  tr.disabled { color: #aaa; background: #fafafa; cursor: not-allowed; }',
            '  td.empty { text-align: center; color: #888; padding: 24px; }',
            '  .footer { margin-top: 14px; text-align: right; }',
            '  button { padding: 6px 14px; font-size: 13px; cursor: pointer; }',
            '</style>',
            '</head><body>',
            '<h2>Select Source Location</h2>',
            '<div class="meta">',
            '  Item ID: <strong>' + escapeHtml(itemId) + '</strong> &nbsp;|&nbsp; ',
            '  Qty Required: <strong>' + formatNum(qtyRequired) + '</strong>',
            (soId ? ' &nbsp;|&nbsp; SO: <strong>' + escapeHtml(soId) + '</strong>' : ''),
            '</div>',
            '<table>',
            '  <thead><tr>',
            '    <th>Location</th>',
            '    <th class="num">Qty On Hand</th>',
            '    <th class="num">Qty Available</th>',
            '    <th class="num">Qty Committed</th>',
            '    <th>Status</th>',
            '  </tr></thead>',
            '  <tbody>', rowHtml, '</tbody>',
            '</table>',
            '<div class="footer">',
            '  <button onclick="window.close()">Cancel</button>',
            '</div>',
            '<script>',
            '  function selectLocation(locId, locName) {',
            '    try {',
            '      if (window.opener && !window.opener.closed) {',
            '        var payload = { source: "bc_picker", lineId: "' + escapeJs(lineId) + '", locId: locId, locName: locName };',
            '        if (typeof window.opener.bcPickerCallback === "function") {',
            '          window.opener.bcPickerCallback(payload);',
            '        } else {',
            '          window.opener.postMessage(payload, "*");',
            '        }',
            '      }',
            '    } catch (e) {',
            '      console.error("Picker callback failed", e);',
            '    }',
            '    window.close();',
            '  }',
            '</script>',
            '</body></html>'
        ].join('\n');
    }

    function renderError(msg) {
        return [
            '<!DOCTYPE html><html><body style="font-family:sans-serif;padding:20px;">',
            '<h3 style="color:#c0392b;">Picker Error</h3>',
            '<p>' + escapeHtml(msg) + '</p>',
            '<button onclick="window.close()">Close</button>',
            '</body></html>'
        ].join('');
    }

    function formatNum(n) {
        if (n === null || n === undefined || isNaN(n)) return '0';
        return Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 });
    }

    function escapeHtml(s) {
        if (s === null || s === undefined) return '';
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function escapeJs(s) {
        if (s === null || s === undefined) return '';
        return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/\r?\n/g, ' ');
    }

    return { onRequest: onRequest };
});
