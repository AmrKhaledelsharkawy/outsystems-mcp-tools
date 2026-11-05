import { describe, expect, it } from "vitest";
import {
  parseSseBody,
  stripCodeFence,
  unwrapCodeText,
  unwrapJson,
  unwrapJsonArray,
  unwrapJsonObject
} from "../src/servicestudio/unwrap.js";

const CODE = "(OutSystems.Model.IReference x) => {\n  var a = 1;\n}";
const FENCED = "```csharp\n" + CODE + "\n```";

describe("parseSseBody", () => {
  it("parses the last data: line of an SSE-framed body", () => {
    const body = `event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"a"}]}}\n\n`;
    const rpc = parseSseBody(body);
    expect(rpc.result?.content?.[0]?.text).toBe("a");
  });

  it("uses the LAST data: line when several are present (CRLF tolerated)", () => {
    const body =
      'event: message\r\ndata: {"jsonrpc":"2.0","id":0,"result":{}}\r\n\r\n' +
      'event: message\r\ndata: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"last"}]}}\r\n';
    expect(parseSseBody(body).result?.content?.[0]?.text).toBe("last");
  });

  it("accepts a plain JSON body", () => {
    const rpc = parseSseBody('{"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"boom"}}');
    expect(rpc.error?.code).toBe(-32000);
  });

  it("throws on empty or data-less bodies", () => {
    expect(() => parseSseBody("")).toThrow();
    expect(() => parseSseBody("event: message\n\n")).toThrow(/data:/);
  });
});

describe("unwrapCodeText", () => {
  it("shape (a): raw fenced code -> code without fences", () => {
    expect(unwrapCodeText(FENCED)).toBe(CODE);
  });

  it("shape (b): JSON string {result: fenced} -> code without fences", () => {
    expect(unwrapCodeText(JSON.stringify({ result: FENCED }))).toBe(CODE);
  });

  it("shape (b) nested twice -> code without fences", () => {
    const twice = JSON.stringify({ result: JSON.stringify({ result: FENCED }) });
    expect(unwrapCodeText(twice)).toBe(CODE);
  });

  it("leaves unfenced plain text as-is (trimmed)", () => {
    expect(unwrapCodeText("  " + CODE + "\n")).toBe(CODE);
  });

  it("strips fences without a language tag and with CRLF line endings", () => {
    expect(stripCodeFence("```\r\nx = 1;\r\n```")).toBe("x = 1;");
  });

  it("does not strip a fence that is not at the very start/end", () => {
    const text = "prefix ```csharp\ncode\n```";
    expect(stripCodeFence(text)).toBe(text);
  });

  it("throws when the inner value is not a string", () => {
    expect(() => unwrapCodeText('{"result":[1,2]}')).toThrow(/expected code text/);
  });
});

describe("unwrapJsonArray", () => {
  const NAMES_ENVELOPE =
    '{"result":"[{\\"Name\\":\\"Login\\",\\"Description\\":\\"\\",\\"UIFlow\\":\\"Login\\",\\"IsReferenced\\":false}]"}';

  it("names tools: {result: '<json array string>'} -> parsed array", () => {
    const arr = unwrapJsonArray<{ Name: string; UIFlow: string; IsReferenced: boolean }>(NAMES_ENVELOPE);
    expect(arr).toEqual([{ Name: "Login", Description: "", UIFlow: "Login", IsReferenced: false }]);
  });

  it("accepts a plain JSON array and an object whose result is already an array", () => {
    expect(unwrapJsonArray('[{"Name":"A"}]')).toEqual([{ Name: "A" }]);
    expect(unwrapJsonArray('{"result":[{"Name":"B"}]}')).toEqual([{ Name: "B" }]);
  });

  it("empty list -> []", () => {
    expect(unwrapJsonArray('{"result":"[]"}')).toEqual([]);
  });

  it("throws when the inner value is not an array", () => {
    expect(() => unwrapJsonArray('{"result":"```csharp\\nx\\n```"}')).toThrow(/expected a JSON array/);
  });
});

describe("unwrapJson / unwrapJsonObject", () => {
  it("listApps: {apps:[...]} (plain or wrapped) -> object", () => {
    const apps = '{"apps":[{"key":"k","name":"x","isOpen":true}]}';
    expect(unwrapJsonObject<{ apps: unknown[] }>(apps).apps).toHaveLength(1);
    expect(unwrapJsonObject<{ apps: unknown[] }>(JSON.stringify({ result: apps })).apps).toHaveLength(1);
  });

  it("returns non-JSON strings unchanged", () => {
    expect(unwrapJson("just text")).toBe("just text");
  });
});

describe("parseSseBody multi-line data events", () => {
  it("joins the data: lines of one event with \\n and takes the last event", () => {
    const body =
      'event: message\ndata: {"jsonrpc":"2.0","id":0,"result":{}}\n\n' +
      'event: message\ndata: {"jsonrpc":"2.0","id":1,\ndata: "result":{"content":[{"type":"text",\ndata: "text":"split"}]}}\n\n';
    const rpc = parseSseBody(body);
    expect(rpc.id).toBe(1);
    expect(rpc.result?.content?.[0]?.text).toBe("split");
  });

  it("ignores a trailing event without data", () => {
    const body = 'data: {"jsonrpc":"2.0","id":7,"result":{}}\n\nevent: ping\n\n';
    expect(parseSseBody(body).id).toBe(7);
  });
});
