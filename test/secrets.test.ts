import { describe, expect, it } from "vitest";
import {
  HIDDEN_CONNECTION_STRING,
  sanitizeConnectionString,
  sanitizeText,
  sanitizeUrl,
} from "../src/secrets.js";

const SECRET = "REVIEW_FAKE_SECRET";

describe("sanitizeConnectionString (fix 2026-09-27 #2)", () => {
  it("masks the user-info password, keeping user, host, port and database", () => {
    expect(sanitizeConnectionString(`postgres://review:${SECRET}@localhost:5432/review`)).toBe(
      "postgres://review:***@localhost:5432/review",
    );
  });

  it("masks password query values, however they are spelled, encoded or repeated", () => {
    for (const url of [
      `postgres://review@localhost/review?password=${SECRET}`,
      `postgres://review@localhost/review?Password=${SECRET}`,
      `postgres://review@localhost/review?pass%77ord=${SECRET}`,
      `postgres://review@localhost/review?password=${encodeURIComponent(`${SECRET} %&=`)}`,
      `postgres://review@localhost/review?password=one&sslmode=require&password=${SECRET}`,
      `postgres://review@localhost/review?sslpassword=${SECRET}&sslmode=verify-full`,
      `postgres://review:${encodeURIComponent(`${SECRET}@:/`)}@localhost/review`,
    ]) {
      const shown = sanitizeConnectionString(url);
      expect(shown).not.toContain(SECRET);
      expect(shown).not.toContain("one");
      expect(shown).toMatch(/^postgres:\/\/review(:\*\*\*)?@localhost\/review/);
    }
    expect(sanitizeConnectionString(`postgres://r@h/d?password=a&sslmode=require&password=b`)).toBe(
      "postgres://r@h/d?password=***&sslmode=require&password=***",
    );
  });

  it("leaves strings without credentials alone", () => {
    const plain = "postgres://review@localhost:5432/review?sslmode=require";
    expect(sanitizeConnectionString(plain)).toBe(plain);
  });

  it("hides malformed or unsupported strings entirely", () => {
    for (const value of [
      `host=localhost password=${SECRET}`,
      `postgres://review:${SECRET}@local host/db`,
      SECRET,
      "",
    ]) {
      expect(sanitizeConnectionString(value)).toBe(HIDDEN_CONNECTION_STRING);
    }
  });

  it("sanitizeUrl ignores non-URLs; sanitizeText masks URLs inside messages", () => {
    expect(sanitizeUrl("llama3.2")).toBeUndefined();
    expect(sanitizeUrl("http://localhost:11434/v1")).toBe("http://localhost:11434/v1");
    expect(sanitizeUrl(`https://user:${SECRET}@proxy.example/v1`)).toBe(
      "https://user:***@proxy.example/v1",
    );
    const message = sanitizeText(
      `connect to postgres://u:${SECRET}@db/x failed; also postgres://u:${SECRET}@bad host`,
    );
    expect(message).not.toContain(SECRET);
    expect(message).toContain("postgres://u:***@db/x failed");
  });
});
