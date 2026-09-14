#!/usr/bin/env python3
"""PreToolUse guard for local issue tracking; scope/limits: plan issue 6448.

This recognizes literal commands, not arbitrary shell/program evaluation.
It never runs the inspected command or makes a network request.
"""

import json
import os
import re
import sys
from urllib.parse import urlsplit


REPOS = {"loopdive/js2", "loopdive/js2wasm"}
REASON = "GitHub issue creation is disabled for loopdive/js2 (alias js2wasm). Allocate a local plan/issues/ issue with scripts/claim-issue.mjs --allocate instead. PR creation and existing issue access remain allowed."


def protected(value):
    value = str(value).lower().rstrip("/")
    value = re.sub(r"^(https?://)?(api\.)?github\.com/", "", value)
    return value.removesuffix(".git") in REPOS


def commands(source):
    """Split literal shell words without treating quoted prose as commands.

    Quotes/backslashes, separators and here-document data are recognized.
    Expansion, substitutions, aliases and sourced programs are not evaluated.
    """
    words, word, pending = [], [], []
    active = False
    quote = None
    i = 0
    while i < len(source):
        c = source[i]
        if quote:
            if c == quote:
                quote = None
            elif c == "\\" and quote == '"' and i + 1 < len(source) and source[i + 1] in '$`"\\\n':
                i += 1
                if source[i] != "\n":
                    word.append(source[i])
            else:
                word.append(c)
        elif c in "'\"":
            active, quote = True, c
        elif c == "\\" and i + 1 < len(source):
            i += 1
            if source[i] != "\n":
                active = True
                word.append(source[i])
        elif c == "#" and not active:
            end = source.find("\n", i)
            i = len(source) if end < 0 else end
            continue
        elif c.isspace() or c in ";&|()<>":
            if active:
                words.append("".join(word))
                word, active = [], False
            if c == "<" and source[i:i + 2] == "<<" and source[i:i + 3] != "<<<":
                match = re.match(r"<<(-?)\s*(['\"]?)([\w-]+)\2", source[i:])
                if not match:
                    raise ValueError("unrecognized here-document delimiter")
                pending.append((match[3], bool(match[1])))
                i += len(match[0])
                continue
            if c in ";&|()\n":
                if words:
                    yield words
                    words = []
                if c == "\n":
                    for delimiter, strip_tabs in pending:
                        while True:
                            start = i + 1
                            end = source.find("\n", start)
                            if end < 0:
                                end = len(source)
                            line = source[start:end]
                            i = end
                            if (line.lstrip("\t") if strip_tabs else line) == delimiter:
                                break
                            if end == len(source):
                                raise ValueError("unterminated here-document")
                    pending = []
        else:
            active = True
            word.append(c)
        i += 1
    if quote or pending:
        raise ValueError("unterminated shell quote or here-document")
    if active:
        words.append("".join(word))
    if words:
        yield words


def option(args, *names):
    for i, arg in enumerate(args):
        for name in names:
            if arg == name and i + 1 < len(args):
                return args[i + 1]
            if arg.startswith(name + "="):
                return arg[len(name) + 1:]
            if len(name) == 2 and arg.startswith(name) and len(arg) > 2:
                return arg[2:]
    return None


def rest_create(endpoint, method):
    if method.upper() != "POST":
        return False
    if endpoint.startswith("https://"):
        url = urlsplit(endpoint)
        if url.netloc.lower() != "api.github.com":
            return False
        endpoint = url.path
    endpoint = endpoint.split("?", 1)[0].strip("/")
    return re.fullmatch(r"repos/loopdive/(js2|js2wasm)/issues", endpoint, re.I) is not None


def api_create(args, curl=False):
    explicit = option(args, "--request", "-X", "--method")
    data_flags = ("--data", "--data-raw", "--data-binary", "--json", "-d") if curl else ("--field", "--raw-field", "--input", "-f", "-F")
    has_data = any(option(args, flag) is not None for flag in data_flags)
    method = explicit or ("POST" if has_data else "GET")
    if curl and ("--get" in args or "-G" in args) and not explicit:
        method = "GET"
    if any(rest_create(arg, method) for arg in args):
        return True
    # Opaque GraphQL repository IDs/payload files cannot establish an unrelated
    # repository here. Visible createIssue mutations fail closed in this project.
    graphql = "graphql" in args or any(arg.startswith("https://api.github.com/graphql") for arg in args)
    return graphql and any(re.search(r"\bcreateIssue\s*\(", arg) for arg in args)


def shell_create(source, default_repo="loopdive/js2", depth=0):
    if depth > 8:
        raise ValueError("shell wrapper nesting exceeds inspection bound")
    for words in commands(source):
        repo = default_repo
        while words and (words[0] in ("env", "command", "exec") or re.match(r"^[A-Za-z_][A-Za-z_0-9]*=", words[0])):
            first = words.pop(0)
            if first.startswith("GH_REPO="):
                repo = first[8:]
        if not words:
            continue
        executable = os.path.basename(words[0])
        args = words[1:]
        if executable in ("sh", "bash", "zsh"):
            for i, arg in enumerate(args[:-1]):
                if re.fullmatch(r"-[a-z]*c[a-z]*", arg) and shell_create(args[i + 1], repo, depth + 1):
                    return True
        if executable == "curl" and api_create(args, curl=True):
            return True
        if executable != "gh":
            continue
        target = option(args, "--repo", "-R") or repo
        # gh accepts its repository selector before or after the subcommand.
        command = list(args)
        while command and command[0].startswith("-"):
            arg = command.pop(0)
            if arg in ("-R", "--repo") and command:
                command.pop(0)
            elif arg not in ("--",) and not arg.startswith(("-R", "--repo=")):
                break
        if command[:2] == ["issue", "create"] and protected(target):
            return True
        if command[:1] == ["api"] and api_create(command[1:]):
            return True
    return False


def denied(event):
    name = event.get("tool_name", "")
    data = event.get("tool_input", {})
    if not isinstance(name, str):
        raise ValueError("tool_name must be a string")
    if not isinstance(data, dict):
        raise ValueError("tool_input must be an object")
    if name in ("Bash", "exec_command", "shell_command", "functions.exec_command"):
        source = data.get("command", data.get("cmd", ""))
        if not isinstance(source, str):
            raise ValueError("shell command must be a string")
        return shell_create(source, os.environ.get("GH_REPO", "loopdive/js2"))
    if "github" not in name.lower():
        return False
    target = data.get("repository_full_name", data.get("repo_full_name", data.get("repository", "")))
    if not target and data.get("owner") and data.get("repo"):
        target = f"{data['owner']}/{data['repo']}"
    if not isinstance(target, str):
        raise ValueError("repository name must be a string")
    create = re.search(r"(?:create_issue|issue_create)$", name) or (name.endswith("issue_write") and data.get("method") == "create")
    if create:
        return not target or protected(target)
    if rest_create(str(data.get("endpoint", data.get("url", ""))), str(data.get("method", "GET"))):
        return True
    return bool(re.search(r"\bcreateIssue\s*\(", str(data.get("query", ""))))


if __name__ == "__main__":
    try:
        event = json.load(sys.stdin)
        if not isinstance(event, dict):
            raise ValueError("hook input must be an object")
        block = denied(event)
        reason = REASON
    except (ValueError, TypeError) as error:
        block, reason = True, f"Issue-creation guard could not inspect this call: {error}"
    if block:
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": reason}}))
        print(reason, file=sys.stderr)
        sys.exit(2)
