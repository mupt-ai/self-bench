"""Grade named JUnit outcomes. Invoked as the verifier user with Python isolated mode."""

import json
import pathlib
import sys
import xml.etree.ElementTree as ET

MAX_REPORT_BYTES = 8 * 1024 * 1024
PASSED = 0
MIXED = 1
INVALID = 2
ALL_FAILED = 10


def read_tests(path: pathlib.Path) -> dict[str, str]:
    if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_REPORT_BYTES:
        raise ValueError("missing, symlinked, or oversized JUnit report")
    raw = path.read_bytes()
    if b"\x00" in raw:
        raise ValueError("only non-NUL XML encodings are supported")
    if b"<!DOCTYPE" in raw.upper() or b"<!ENTITY" in raw.upper():
        raise ValueError("DTD/entity declarations are forbidden")
    root = ET.fromstring(raw)
    if root.tag not in ("testsuites", "testsuite"):
        raise ValueError("expected testsuite or testsuites root")
    tests = {}
    for case in root.iter("testcase"):
        name = case.get("name", "")
        identity = case.get("classname", "") + "::" + name
        if not name or identity in tests:
            raise ValueError("missing or duplicate test identity: " + identity)
        # Highest-priority non-passing outcome wins when a malformed case has several.
        tests[identity] = next(
            (state for tag, state in (("error", "error"), ("skipped", "skipped"), ("failure", "failed"))
             if case.find(tag) is not None),
            "passed",
        )
    if root.find(".//error") is not None:
        raise ValueError("JUnit contains collection/runtime errors")
    return tests


def grade(tests: dict[str, str], expected: list[str], command_exit: int) -> int:
    states = [tests.get(name, "missing") for name in expected]
    if not states or any(state not in ("passed", "failed") for state in states):
        raise ValueError("expected tests missing, skipped, or errored")
    has_failure = "failed" in tests.values()
    if command_exit not in (0, 1) or (command_exit == 0 and has_failure) or (command_exit == 1 and not has_failure):
        raise ValueError("command exit and test outcomes disagree or command failed unexpectedly")
    if all(state == "passed" for state in states) and command_exit == 0:
        return PASSED
    if all(state == "failed" for state in states):
        return ALL_FAILED
    return MIXED


def main() -> int:
    result = {"format": "junit", "valid": False, "tests": {}, "reason": ""}
    status = INVALID
    try:
        path, expected_json, command_exit = sys.argv[1:]
        result["tests"] = read_tests(pathlib.Path(path))
        status = grade(result["tests"], json.loads(expected_json), int(command_exit))
        result["valid"] = True
    except (OSError, ValueError, ET.ParseError) as error:
        result["reason"] = str(error)
    print(json.dumps(result, sort_keys=True))
    return status


if __name__ == "__main__":
    sys.exit(main())
