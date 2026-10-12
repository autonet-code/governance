# Indexer end-to-end, phase C: compare what the indexer wrote to the Firestore EMULATOR with
# what events.js did on-chain (out/manifest.json). Prints PASS/FAIL lines; exit code 1 on any FAIL.
#   python scripts/indexer-e2e/verify.py <indexer dir>
import json, os, sys
os.environ["FIRESTORE_EMULATOR_HOST"] = "127.0.0.1:8080"  # never touch production
import firebase_admin
from firebase_admin import credentials, firestore

indexer_dir = sys.argv[1]
here = os.path.dirname(__file__)
manifest = json.load(open(os.path.join(here, "out", "manifest.json")))

def client(name, cred):
    return firestore.client(firebase_admin.initialize_app(credentials.Certificate(os.path.join(indexer_dir, cred)), name=name))

hb = client("homebase", "homebase.json")
tl = client("trustless", "secrets/trustless.json")
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
    if kind == "economy":
        econ = find_doc(tl.collection("Localhost"), d["economy"])
        check("[economy] trustless economy doc exists", econ is not None, d["economy"])
        check("[economy] DAO doc links economy", (snap.to_dict().get("economy") or "").lower() == d["economy"].lower(),
              f"got {snap.to_dict().get('economy')!r}")

# ---------------- Trustless side ----------------
economy = manifest["daos"]["economy"]["economy"]
econ_doc = find_doc(tl.collection("Localhost"), economy)
econ_ref = econ_doc.reference if econ_doc else tl.collection("Localhost").document(economy.lower())
transactions = [t.to_dict() for t in econ_ref.collection("transactions").stream()]
for key, p in manifest["projects"].items():
    snap = find_doc(econ_ref.collection("projects"), p["address"])
    check(f"[{key}] project doc exists", snap is not None, p["address"])
    if not snap:
        continue
    data = snap.to_dict()
    check(f"[{key}] stage", str(data.get("stage", "")).lower() == p["stage"], f"got {data.get('stage')!r}")
    if "disputeResolution" in p:
        check(f"[{key}] disputeResolution", str(data.get("disputeResolution")) == str(p["disputeResolution"]),
              f"got {data.get('disputeResolution')!r}")
    if "appealProposalId" in p:
        check(f"[{key}] appeal proposal linked", str(data.get("appealProposalId")) == p["appealProposalId"],
              f"got {data.get('appealProposalId')!r}")
    backer_ids = [b.id.lower() for b in snap.reference.collection("backers").stream()]
    for b in p["backers"]:
        check(f"[{key}] backer {b[:8]} doc", b.lower() in backer_ids, f"backers={backer_ids}")
    fns = sorted({t.get("functionName") for t in transactions if (t.get("projectId") or "").lower() == p["address"].lower()})
    print(f"      [{key}] recorded transactions: {fns}")

print(f"\n{failures} failure(s)")
sys.exit(1 if failures else 0)
