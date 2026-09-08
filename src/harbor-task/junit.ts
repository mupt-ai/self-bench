/** Standard-library-only adapter, embedded in the trusted verifier (not authored by the agent). */
export const JUNIT_READER = String.raw`
import json, pathlib, sys, xml.etree.ElementTree as ET

path, expected_json, command_exit = sys.argv[1:]
expected = json.loads(expected_json)
result = {"format": "junit", "valid": False, "tests": {}, "reason": ""}
status = 2
try:
    report = pathlib.Path(path)
    if report.is_symlink() or not report.is_file() or report.stat().st_size > 8 * 1024 * 1024:
        raise ValueError("missing, symlinked, or oversized JUnit report")
    raw = report.read_bytes()
    if b"\x00" in raw: raise ValueError("only non-NUL XML encodings are supported")
    if b"<!DOCTYPE" in raw.upper() or b"<!ENTITY" in raw.upper():
        raise ValueError("DTD/entity declarations are forbidden")
    root = ET.fromstring(raw)
    if root.tag not in ("testsuites", "testsuite"):
        raise ValueError("expected testsuite or testsuites root")
    for case in root.iter("testcase"):
        name = case.get("name", "")
        identity = case.get("classname", "") + "::" + name
        if not name or identity in result["tests"]:
            raise ValueError("missing or duplicate test identity: " + identity)
        state = "passed"
        if case.find("failure") is not None: state = "failed"
        if case.find("skipped") is not None: state = "skipped"
        if case.find("error") is not None: state = "error"
        result["tests"][identity] = state
    if root.find(".//error") is not None or root.find("error") is not None:
        raise ValueError("JUnit contains collection/runtime errors")
    states = [result["tests"].get(name, "missing") for name in expected]
    if not states or any(state not in ("passed", "failed") for state in states):
        raise ValueError("expected tests missing, skipped, or errored")
    all_states = list(result["tests"].values())
    code = int(command_exit)
    if code not in (0, 1) or (code == 0 and "failed" in all_states) or (code == 1 and "failed" not in all_states):
        raise ValueError("command exit and test outcomes disagree or command failed unexpectedly")
    result["valid"] = True
    if all(state == "passed" for state in states) and code == 0:
        status = 0
    elif all(state == "failed" for state in states):
        status = 10
    else:
        status = 1
except (OSError, ValueError, ET.ParseError) as error:
    result["reason"] = str(error)
print(json.dumps(result, sort_keys=True))
sys.exit(status)
`;
