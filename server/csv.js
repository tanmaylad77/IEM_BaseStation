import { CSV_HEADINGS } from "./config.js";

export function recordsToCsv(records) {
  return [
    CSV_HEADINGS.join(","),
    ...records.map(record => CSV_HEADINGS.map(heading => csvCell(record[heading])).join(","))
  ].join("\n") + "\n";
}

function csvCell(value) {
  if (value === null || value === undefined) {
    return "";
  }
  const text = String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}
