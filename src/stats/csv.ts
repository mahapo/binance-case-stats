import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// CSV parsing — proven against this dataset (carried over from the v1 engine).
// ---------------------------------------------------------------------------
export function parseLine(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const nextChar = line[i + 1];
    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      values.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  values.push(current.trim());
  return values;
}

export function parseCSV(content: string): Record<string, string>[] {
  const lines = content.replace(/^﻿/, "").split("\n").filter((l) => l.trim());
  if (lines.length === 0) return [];
  const headers = parseLine(lines[0]);
  const records: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const values = parseLine(lines[i]);
    if (values.length === headers.length) {
      const record: Record<string, string> = {};
      for (let j = 0; j < headers.length; j++) record[headers[j]] = values[j];
      records.push(record);
    }
  }
  return records;
}

export function parseAmount(value: string | undefined): number {
  if (!value || value === "") return 0;
  const num = parseFloat(String(value).replace(/,/g, ""));
  return isNaN(num) ? 0 : num;
}

// Fee fields look like "-0.00770364 USDT"; strip the asset suffix.
export function parseFee(value: string | undefined): number {
  if (!value || value === "") return 0;
  const match = String(value).match(/^-?\d+\.?\d*([eE][+-]?\d+)?/);
  if (match) {
    const num = parseFloat(match[0]);
    return isNaN(num) ? 0 : num;
  }
  return 0;
}

export const parseTradeDate = (s: string): Date => new Date(s + "Z"); // "2024-01-05 17:30:08"
export const parseTxDate = (s: string): Date => // "24-01-05 19:24:25"
  new Date(
    "20" + s.substring(0, 2) + "-" + s.substring(3, 5) + "-" +
      s.substring(6, 8) + "T" + s.substring(9) + "Z",
  );
// Orders files: old layout uses "Time(UTC)" (4-digit year), new layout "Time" (2-digit year).
export const parseOrdDate = (s: string): Date =>
  /^\d{4}-/.test(s) ? new Date(s + "Z") : parseTxDate(s);

export const getYear = (d: Date): string => d.getUTCFullYear().toString();
export const getYearMonth = (d: Date): string =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

export function listCsv(dir: string): string[] {
  return fs.readdirSync(dir).filter((f) => f.endsWith(".csv")).sort();
}

export function readCsvDir(dir: string): Record<string, string>[] {
  return listCsv(dir).flatMap((f) => parseCSV(fs.readFileSync(path.join(dir, f), "utf-8")));
}
