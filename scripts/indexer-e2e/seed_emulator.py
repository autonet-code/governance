# Indexer end-to-end: write the contracts/Localhost config doc into the Firestore EMULATOR only.
# The indexer writes DAOs and their Economy projects to homebase-6907d.
#   python scripts/indexer-e2e/seed_emulator.py <indexer dir>
import json, os, sys
os.environ["FIRESTORE_EMULATOR_HOST"] = os.environ.get("E2E_EMULATOR_HOST") or "127.0.0.1:8080"  # never touch production
import firebase_admin
from firebase_admin import credentials, firestore

indexer_dir = sys.argv[1]
dep = json.load(open(os.path.join(os.path.dirname(__file__), "out", "deployment.json")))
for name, cred in [("homebase", "homebase.json")]:
    app = firebase_admin.initialize_app(credentials.Certificate(os.path.join(indexer_dir, cred)), name=name)
    db = firestore.client(app)
    db.collection("contracts").document("Localhost").set(dep)
    print(name, app.project_id, "seeded contracts/Localhost")
