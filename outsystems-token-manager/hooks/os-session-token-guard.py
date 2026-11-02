"""Service Studio MCP session-token hooks (PreToolUse, PostToolUse, PostToolUseFailure).

Token file: <CLAUDE_PROJECT_DIR or cwd>/token.txt.
- PreToolUse  createSessionToken: deny while token.txt exists (validate via listApps first).
- PreToolUse  any other servicestudio tool: deny when sessionToken is missing; the reason
  carries the saved token when the file exists, else says to call createSessionToken.
- PostToolUse createSessionToken: write the returned token to token.txt.
- PostToolUse / PostToolUseFailure listApps: on token rejection delete token.txt and tell
  the model to call createSessionToken.
"""

import json
import os
import re
import sys

PREFIX = "mcp__servicestudio__"
CREATE = PREFIX + "createSessionToken"
LIST_APPS = PREFIX + "listApps"
TOKEN_FILE = "token.txt"

REJECTION_MARKERS = (
    "requires a valid session token",
    "session token",
    "invalid",
    "rejected",
    "unauthorized",
    "not authorized",
)


# --- token file -------------------------------------------------------------

def token_path(event):
    base = os.environ.get("CLAUDE_PROJECT_DIR") or event.get("cwd") or os.getcwd()
    return os.path.normpath(os.path.join(base, TOKEN_FILE))


def read_token(path):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return fh.read().strip()
    except OSError:
        return ""


def write_token(path, token):
    try:
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(token + "\n")
        return True
    except OSError:
        return False


def delete_token(path):
    try:
        os.remove(path)
    except OSError:
        pass


# --- response parsing -------------------------------------------------------

def response_text(resp):
    """Flatten a tool_response (string, dict, MCP content list) to text."""
    if resp is None:
        return ""
    if isinstance(resp, str):
        return resp
    if isinstance(resp, list):
        parts = []
        for item in resp:
            if isinstance(item, dict) and isinstance(item.get("text"), str):
                parts.append(item["text"])
            else:
                parts.append(response_text(item))
        return "\n".join(parts)
    if isinstance(resp, dict):
        for key in ("content", "result", "structuredContent"):
            if key in resp:
                inner = response_text(resp[key])
                if inner:
                    return inner
        try:
            return json.dumps(resp)
        except (TypeError, ValueError):
            return str(resp)
    return str(resp)


TOKEN_KEYS = ("sessionToken", "session_token", "token")
TOKEN_RE = re.compile(r"^[A-Za-z0-9._\-+/=:]{8,}$")


def extract_token(resp):
    """Find the token in a createSessionToken response (string or object)."""
    if isinstance(resp, str):
        return _token_from_text(resp)
    if isinstance(resp, dict):
        for key in TOKEN_KEYS:
            val = resp.get(key)
            if isinstance(val, str) and val.strip():
                return val.strip()
        for key in ("structuredContent", "result", "content"):
            if key in resp:
                found = extract_token(resp[key])
                if found:
                    return found
        if isinstance(resp.get("text"), str):
            return _token_from_text(resp["text"])
        return ""
    if isinstance(resp, list):
        for item in resp:
            found = extract_token(item)
            if found:
                return found
        return ""
    return ""


def _token_from_text(text):
    text = text.strip()
    if not text:
        return ""
    # JSON-encoded object or string inside a text block
    if text[0] in "{[\"":
        try:
            parsed = json.loads(text)
        except ValueError:
            parsed = None
        if isinstance(parsed, str):
            return parsed.strip() if TOKEN_RE.match(parsed.strip()) else ""
        if parsed is not None:
            return extract_token(parsed)
    if TOKEN_RE.match(text):
        return text
    # "token: xyz" / "Session token xyz" style
    m = re.search(r"(?i)token[\"'\s:=]+([A-Za-z0-9._\-+/=:]{8,})", text)
    return m.group(1) if m else ""


def looks_rejected(text):
    low = text.lower()
    return any(marker in low for marker in REJECTION_MARKERS)


# --- output -----------------------------------------------------------------

def emit(event_name, **fields):
    out = {"hookEventName": event_name}
    out.update(fields)
    print(json.dumps({"hookSpecificOutput": out}))


def deny(reason):
    emit("PreToolUse", permissionDecision="deny", permissionDecisionReason=reason)


# --- handlers ---------------------------------------------------------------

def pre_tool_use(event, name):
    path = token_path(event)
    saved = read_token(path)

    if name == CREATE:
        if saved:
            deny(
                "A saved Service Studio session token exists in token.txt. Validate it "
                "first: call mcp__servicestudio__listApps with sessionToken \"" + saved + "\". "
                "If listApps succeeds, keep using that token (no approval dialog needed). "
                "If listApps rejects it, delete token.txt (" + path + ") and only then "
                "call createSessionToken. Never echo the token in chat."
            )
        return

    arguments = event.get("tool_input")
    token = arguments.get("sessionToken") if isinstance(arguments, dict) else None
    if isinstance(token, str) and token.strip():
        return

    if saved:
        deny(
            "This Service Studio call has no sessionToken. A saved token exists in token.txt: "
            "retry with sessionToken \"" + saved + "\" as a top-level argument (also for "
            "omlPublish, omlRefreshReferences and getRoleExceptions, whose schemas omit it). "
            "First servicestudio call of a session must be listApps with this token; if it is "
            "rejected, delete " + path + " and call createSessionToken. Never echo the token in chat."
        )
    else:
        deny(
            "Service Studio requires a session token and none is saved. Call "
            "mcp__servicestudio__createSessionToken once (the user approves in Service Studio); "
            "the token is written to token.txt automatically. Then retry this call with the "
            "returned sessionToken as a top-level argument. Never echo the token in chat."
        )


def post_tool_use(event, name):
    path = token_path(event)
    resp = event.get("tool_response")

    if name == CREATE:
        token = extract_token(resp)
        if not token:
            emit("PostToolUse", additionalContext=(
                "createSessionToken returned no recognizable token; token.txt was not written. "
                "Pass the token you received as sessionToken on every call and save it to "
                + path + " yourself (file content: the token only)."
            ))
            return
        if write_token(path, token):
            emit("PostToolUse", additionalContext=(
                "Session token saved to token.txt; the next session reuses it via listApps. "
                "Pass it as sessionToken on every Service Studio call. Never echo it in chat."
            ))
        else:
            emit("PostToolUse", additionalContext=(
                "Could not write token.txt at " + path + ". Keep passing the returned token as "
                "sessionToken this session; it will not be reused next session."
            ))
        return

    if name == LIST_APPS:
        text = response_text(resp)
        if looks_rejected(text) and "apps" not in text.lower():
            delete_token(path)
            emit("PostToolUse", additionalContext=(
                "listApps rejected the session token; token.txt was deleted. Call "
                "mcp__servicestudio__createSessionToken now (user approves in Service Studio), "
                "then retry with the new token."
            ))
        else:
            emit("PostToolUse", additionalContext=(
                "listApps accepted the session token. Keep using it for every Service Studio "
                "call this session; do not call createSessionToken."
            ))


def post_tool_use_failure(event, name):
    path = token_path(event)
    if name != LIST_APPS:
        return
    err = event.get("error")
    text = err if isinstance(err, str) else response_text(err)
    if looks_rejected(text):
        delete_token(path)
        emit("PostToolUseFailure", additionalContext=(
            "listApps rejected the session token; token.txt was deleted. Call "
            "mcp__servicestudio__createSessionToken now (user approves in Service Studio), "
            "then retry with the new token."
        ))
    else:
        emit("PostToolUseFailure", additionalContext=(
            "listApps failed for a reason other than token rejection (transport or server). "
            "token.txt was kept; fix the connection and retry listApps with the same token."
        ))


def main():
    try:
        event = json.load(sys.stdin)
    except (ValueError, OSError):
        return
    if not isinstance(event, dict):
        return

    name = event.get("tool_name")
    if not isinstance(name, str) or not name.startswith(PREFIX):
        return

    hook = event.get("hook_event_name") or "PreToolUse"
    if hook == "PreToolUse":
        pre_tool_use(event, name)
    elif hook == "PostToolUse":
        post_tool_use(event, name)
    elif hook == "PostToolUseFailure":
        post_tool_use_failure(event, name)


if __name__ == "__main__":
    main()
