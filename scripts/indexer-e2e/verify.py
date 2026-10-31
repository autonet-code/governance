# Indexer end-to-end, phase C: compare what the indexer wrote to the Firestore EMULATOR with
# what events.js did on-chain (out/manifest.json). Prints PASS/FAIL lines; exit code 1 on any FAIL.
#   python scripts/indexer-e2e/verify.py <indexer dir>
import json, os, sys
os.environ["FIRESTORE_EMULATOR_HOST"] = os.environ.get("E2E_EMULATOR_HOST") or "127.0.0.1:8080"  # never touch production
import firebase_admin
from firebase_admin import credentials, firestore
from google.cloud.firestore_v1.base_query import FieldFilter

indexer_dir = sys.argv[1]
here = os.path.dirname(__file__)
manifest = json.load(open(os.path.join(here, "out", "manifest.json")))

def client(name, cred):
    return firestore.client(firebase_admin.initialize_app(credentials.Certificate(os.path.join(indexer_dir, cred)), name=name))

hb = client("homebase", "homebase.json")
failures = 0

def check(label, ok, detail=""):
    global failures
    failures += 0 if ok else 1
    print(f"{'PASS' if ok else 'FAIL'}  {label}{'' if ok else '  -> ' + detail}")

def find_doc(collection, doc_id):
    # Doc ids may be checksummed or lowercase depending on the writer
    for candidate in (doc_id, doc_id.lower()):
        snap = collection.document(candidate).get()
        if snap.exists:
            return snap
    for snap in collection.stream():
        if snap.id.lower() == doc_id.lower():
            return snap
    return None

# ---------------- DAO side ----------------
daos = hb.collection("idaosLocalhost")
for kind, d in manifest["daos"].items():
    if not d.get("dao"):
        check(f"[{kind}] DAO address known", False, "events.js could not determine the DAO address")
        continue
    snap = find_doc(daos, d["dao"])
    check(f"[{kind}] DAO doc exists", snap is not None, d["dao"])
    if not snap:
        continue
    members = snap.reference.collection("members")
    for addr, balance in d.get("members", {}).items():
        m = find_doc(members, addr)
        check(f"[{kind}] member {addr[:8]} indexed", m is not None)
        if m:
            got = m.to_dict().get("personalBalance")
            check(f"[{kind}] member {addr[:8]} balance", str(got) == str(balance), f"got {got}, expected {balance}")
    for addr, delegatee in d.get("delegates", {}).items():
        m = find_doc(members, addr)
        got = (m.to_dict().get("delegate") if m else None) or ""
        check(f"[{kind}] member {addr[:8]} delegate", got.lower() == delegatee.lower(), f"got {got!r}, expected {delegatee}")
    for addr, weight in d.get("votingWeights", {}).items():
        m = find_doc(members, addr)
        got = m.to_dict().get("votingWeight") if m else None
        check(f"[{kind}] member {addr[:8]} votingWeight", str(got) == str(weight), f"got {got}, expected {weight}")
    for pid, p in d.get("proposals", {}).items():
        ps = find_doc(snap.reference.collection("proposals"), pid)
        check(f"[{kind}] proposal {pid[:10]} indexed", ps is not None)
        if ps:
            data = ps.to_dict()
            check(f"[{kind}] proposal {pid[:10]} stage", str(data.get("latestStage", "")).lower() == p["state"].lower(),
                  f"got {data.get('latestStage')!r}, statusHistory={list((data.get('statusHistory') or {}).keys())}")
            check(f"[{kind}] proposal {pid[:10]} votes for", str(data.get("inFavor")) == p["forVotes"],
                  f"got inFavor={data.get('inFavor')!r}, expected {p['forVotes']}")
            votes = list(ps.reference.collection("votes").stream())
            check(f"[{kind}] proposal {pid[:10]} vote docs", len(votes) >= 1, f"{len(votes)} vote docs")
    for key, value in d.get("registryValues", {}).items():
        got = (snap.to_dict().get("registry") or {}).get(key)
        check(f"[{kind}] registry {key}", got == value, f"got {got!r}, expected {value!r}")
    for field, value in d.get("fields", {}).items():
        got = snap.to_dict().get(field)
        check(f"[{kind}] {field}", str(got).lower() == str(value).lower(), f"got {got!r}, expected {value!r}")
    # Economy module: attached at origination or by proposal (jurisdiction.economy), or detached
    if d.get("economy"):
        check(f"[{kind}] DAO doc links economy", (snap.to_dict().get("economy") or "").lower() == d["economy"].lower(),
              f"got {snap.to_dict().get('economy')!r}")
    # Its activity feed: each expected kind of event, every entry complete, links that resolve
    feed = [a.to_dict() for a in snap.reference.collection("activity").stream()]
    if d.get("activity"):
        types = {a.get("type") for a in feed}
        for t in d["activity"]:
            check(f"[{kind}] activity {t}", t in types, f"types={sorted(types)}")
        incomplete = [a for a in feed if not (a.get("summary") and a.get("time") and str(a.get("txHash", "")).startswith("0x"))]
        check(f"[{kind}] activity entries complete", not incomplete, f"{len(incomplete)} incomplete, e.g. {incomplete[:1]}")
        proposals = {p.id for p in snap.reference.collection("proposals").stream()}
        projects = {p.id.lower() for p in snap.reference.collection("projects").stream()}
        dangling = [a for a in feed if (a.get("targetKind") == "proposal" and a.get("targetId") not in proposals)
                    or (a.get("targetKind") == "project" and a.get("targetId", "").lower() not in projects)]
        check(f"[{kind}] activity links resolve", not dangling, f"{len(dangling)} dangling, e.g. {dangling[:1]}")
    for addr in d.get("debates", []):
        check(f"[{kind}] debate {addr[:8]} recorded", find_doc(snap.reference.collection("debates"), addr) is not None)
        check(f"[{kind}] debate {addr[:8]} in the feed",
              any(a.get("targetKind") == "debate" and a.get("targetId", "").lower() == addr.lower() for a in feed))
    for addr in d.get("agents", []):
        check(f"[{kind}] agent {addr[:8]} in the feed",
              any(a.get("targetKind") == "agent" and a.get("targetId", "").lower() == addr.lower() for a in feed))
    if d.get("economyDetached"):
        check(f"[{kind}] DAO doc economy unlinked", not snap.to_dict().get("economy"), f"got {snap.to_dict().get('economy')!r}")
    # Projects stay under the DAO, also after its economy is detached
    for addr, expected in d.get("projects", {}).items():
        ps = find_doc(snap.reference.collection("projects"), addr)
        check(f"[{kind}] project {addr[:8]} under the DAO", ps is not None, addr)
        if ps:
            pdata = ps.to_dict()
            check(f"[{kind}] project {addr[:8]} stage", pdata.get("stage") == expected["stage"], f"got {pdata.get('stage')!r}")
            check(f"[{kind}] project {addr[:8]} economyAddress", (pdata.get("economyAddress") or "").lower() == expected["economy"].lower(),
                  f"got {pdata.get('economyAddress')!r}")

# ---------------- Economy projects ----------------
# Under the Economy's DAO in homebase: idaosLocalhost/{dao}/projects/{project}, with backers/ and activity/
eco = manifest["daos"]["economy"]
eco_dao = find_doc(daos, eco["dao"])
projects_ref = (eco_dao.reference if eco_dao else daos.document(eco["dao"])).collection("projects")
proposals_ref = (eco_dao.reference if eco_dao else daos.document(eco["dao"])).collection("proposals")
for key, p in manifest["projects"].items():
    snap = find_doc(projects_ref, p["address"])
    check(f"[{key}] project doc exists", snap is not None, p["address"])
    if not snap:
        continue
    data = snap.to_dict()
    check(f"[{key}] stage", str(data.get("stage", "")).lower() == p["stage"], f"got {data.get('stage')!r}")
    check(f"[{key}] economyAddress", (data.get("economyAddress") or "").lower() == eco["economy"].lower(),
          f"got {data.get('economyAddress')!r}")
    if "disputeResolution" in p:
        check(f"[{key}] disputeResolution", str(data.get("disputeResolution")) == str(p["disputeResolution"]),
              f"got {data.get('disputeResolution')!r}")
    if "appealProposalId" in p:
        expected = p["appealProposalId"]
        if expected is None:
            check(f"[{key}] failed appeal unlinked", data.get("appealProposalId") is None, f"got {data.get('appealProposalId')!r}")
        else:
            check(f"[{key}] appeal proposal linked", str(data.get("appealProposalId")) == expected,
                  f"got {data.get('appealProposalId')!r}")
    if "vetoProposalId" in p:
        expected = p["vetoProposalId"]
        if expected is None:
            check(f"[{key}] failed veto unlinked", data.get("vetoProposalId") is None, f"got {data.get('vetoProposalId')!r}")
        else:
            check(f"[{key}] veto proposal linked", str(data.get("vetoProposalId")) == expected,
                  f"got {data.get('vetoProposalId')!r}")
    for pid in p.get("vetoProposals", []):
        ps = find_doc(proposals_ref, pid)
        pdata = ps.to_dict() if ps else {}
        check(f"[{key}] veto proposal {pid[:10]} typed veto", pdata.get("type") == "veto", f"got {pdata.get('type')!r}")
        check(f"[{key}] veto proposal {pid[:10]} names the project",
              (pdata.get("vetoProject") or "").lower() == p["address"].lower(), f"got {pdata.get('vetoProject')!r}")
    for pid in p.get("appealProposals", []) + p.get("vetoProposals", []):
        entry = [e for e in eco_dao.reference.collection("activity").where(filter=FieldFilter("targetId", "==", pid)).get()
                 if e.to_dict().get("type") == "proposalCreated"] if eco_dao else []
        want = "appeal" if pid in p.get("appealProposals", []) else "veto"
        check(f"[{key}] {want} proposal {pid[:10]} in the feed as {want}",
              any(e.to_dict().get("proposalType") == want for e in entry), f"{[e.to_dict() for e in entry]}")
    for pid in p.get("appealProposals", []):
        ps = find_doc(proposals_ref, pid)
        pdata = ps.to_dict() if ps else {}
        check(f"[{key}] appeal proposal {pid[:10]} typed appeal", pdata.get("type") == "appeal", f"got {pdata.get('type')!r}")
        check(f"[{key}] appeal proposal {pid[:10]} names the project",
              (pdata.get("appealProject") or "").lower() == p["address"].lower(), f"got {pdata.get('appealProject')!r}")
    backer_ids = [b.id.lower() for b in snap.reference.collection("backers").stream()]
    for b in p["backers"]:
        check(f"[{key}] backer {b[:8]} doc", b.lower() in backer_ids, f"backers={backer_ids}")
    fns = sorted({a.to_dict().get("functionName") for a in snap.reference.collection("activity").stream()})
    check(f"[{key}] activity recorded", "createProject" in fns, f"got {fns}")
    print(f"      [{key}] recorded activity: {fns}")

print(f"\n{failures} failure(s)")
sys.exit(1 if failures else 0)
