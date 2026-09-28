// CSV and Excel exports. Ported from export_csv_now / export_excel_now.
import ExcelJS from "exceljs";

import { cleanLabel, DISPLAY_TIMEZONE, parseIso } from "./data.js";

function csvEscape(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function rowsToCsv(rows) {
  const lines = [["brand", "model", "part", "source", "price", "currency", "last_checked", "url"].join(",")];
  for (const row of rows) {
    lines.push([row.brand, cleanLabel(row.model), row.part, row.source, row.price_value, row.currency, row.date, row.url].map(csvEscape).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

/** ISO timestamp -> a Date whose UTC fields carry the India wall-clock time, so Excel shows local time. */
function excelDate(value) {
  const date = parseIso(value);
  if (!date) return value || "";
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: DISPLAY_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute), Number(parts.second)));
}

function styleSheet(sheet, widths, moneyColumns, dateColumns) {
  const header = sheet.getRow(1);
  header.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F3A8A" } };
    cell.alignment = { vertical: "middle" };
  });
  widths.forEach((width, index) => {
    sheet.getColumn(index + 1).width = width;
  });
  for (const column of moneyColumns) sheet.getColumn(column).numFmt = "#,##0";
  for (const column of dateColumns) sheet.getColumn(column).numFmt = "dd-mmm-yyyy hh:mm";
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  if (sheet.rowCount > 1) sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: sheet.rowCount, column: sheet.columnCount } };
}

export async function rowsToExcel(rows) {
  const workbook = new ExcelJS.Workbook();
  const prices = workbook.addWorksheet("Prices");
  prices.addRow(["Brand", "Model", "Spare Part", "Category", "Source", "Price", "Currency", "Other Source", "Other Source Part", "Other Source Price", "Last Checked", "Source URL"]);
  for (const row of rows) {
    const other = row.competitors?.[0] || null;
    prices.addRow([
      row.brand, cleanLabel(row.model), row.part, row.category || "", row.source, row.price_value, row.currency || "",
      other ? other.source : "", other ? other.part : "", other ? other.price_value : null, excelDate(row.date), row.url,
    ]);
  }
  styleSheet(prices, [12, 30, 34, 16, 12, 12, 10, 14, 30, 18, 20, 60], [6, 10], [11]);

  // One line per repair that both the brand and Cashify price, side by side.
  const compare = workbook.addWorksheet("Official vs Cashify");
  compare.addRow(["Brand", "Model", "Category", "Official Part", "Official Price", "Cashify Part", "Cashify Price", "Difference (Official - Cashify)", "Cheaper"]);
  for (const row of rows) {
    if (row.source === "Cashify") continue;
    for (const other of row.competitors || []) {
      if (other.source !== "Cashify" || row.price_value === null || other.price_value === null) continue;
      const difference = row.price_value - other.price_value;
      const cheaper = difference === 0 ? "Same" : difference > 0 ? "Cashify" : row.source;
      compare.addRow([row.brand, cleanLabel(row.model), row.category, row.part, row.price_value, other.part, other.price_value, difference, cheaper]);
    }
  }
  styleSheet(compare, [12, 30, 16, 34, 16, 28, 16, 30, 12], [5, 7, 8], []);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
