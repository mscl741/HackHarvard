import json
import math
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from panel_advisor_v3 import answer_question

HOST = os.getenv("HOST", "127.0.0.1")
PORT = int(os.getenv("PORT", "8766"))

WARNINGS = [
    "Current matching is a preliminary heuristic, not measured maximum power.",
    "Voc and Isc alone cannot confirm compatibility with an electrical load.",
    "Verify operating voltage, current limits, controller compatibility and startup power.",
    "Panel grades are relative demo indicators, not safety certifications."
]


def validate_panels(panels):
    if not isinstance(panels, list) or len(panels) != 4:
        raise ValueError("Exactly four panels are required.")

    cleaned = []
    ids = set()

    for panel in panels:
        if not isinstance(panel, dict):
            raise ValueError("Each panel must be an object.")

        name = panel.get("id")
        if not isinstance(name, str) or len(name) != 1 or not name.isalpha():
            raise ValueError("Panel IDs must be single letters.")

        name = name.upper()
        if name in ids:
            raise ValueError("Duplicate panel ID.")
        ids.add(name)

        isc = float(panel["isc_a"])
        voc = float(panel["voc_v"])

        if not all(math.isfinite(v) and v > 0 for v in (isc, voc)):
            raise ValueError("Isc and Voc must be positive finite numbers.")

        cleaned.append({"id": name, "isc_a": isc, "voc_v": voc})

    return cleaned


def offline_context(panels, data_source):
    currents = {p["id"]: p["isc_a"] for p in panels}
    names = sorted(currents)
    first = names[0]
    configurations = []

    for partner in names[1:]:
        remaining = [
            n for n in names if n not in (first, partner)
        ]

        score = (
            min(currents[first], currents[partner])
            + min(currents[remaining[0]], currents[remaining[1]])
        )

        pairing = (
            first + partner + "|"
            + "".join(remaining)
        )

        configurations.append({
            "pairing": pairing,
            "estimated_current_a": round(score, 4)
        })

    best = max(
        configurations,
        key=lambda x: x["estimated_current_a"]
    )

    strongest = max(currents.values())
    sorted_voc = sorted(p["voc_v"] for p in panels)
    median_voc = (sorted_voc[1] + sorted_voc[2]) / 2

    passports = []

    for panel in sorted(panels, key=lambda p: p["id"]):
        score = round(
            100 * panel["isc_a"] / strongest, 1
        )

        passports.append({
            **panel,
            "relative_current_score": score,
            "preliminary_grade": (
                "A" if score >= 85 else
                "B" if score >= 65 else "C"
            ),
            "possible_voltage_anomaly": (
                panel["voc_v"] < 0.8 * median_voc
            )
        })

    return {
        "recommended_pairing": best["pairing"],
        "panel_passports": passports,
        "warnings": WARNINGS,
        "data_source": data_source,
        "configurations": configurations
    }


def process_request(payload):
    question = payload.get("question", "")
    if not isinstance(question, str) or not question.strip():
        raise ValueError("A nonempty question is required.")

    if len(question) > 2000:
        raise ValueError("Question is too long.")

    panels = validate_panels(payload.get("panels"))

    mode = payload.get("mode", "auto")
    if mode not in ("online", "offline", "auto"):
        raise ValueError("Mode must be online, offline, or auto.")

    data_source = payload.get("data_source", "UNSPECIFIED")
    if data_source not in ("SIMULATED", "HARDWARE", "UNSPECIFIED"):
        raise ValueError("Invalid data_source.")

    # This API does not itself verify hardware provenance.
    hardware_verified = False
    fallback_reason = None

    if mode in ("online", "auto"):
        try:
            from panel_advisor_v3 import prepare_context
            from chalk_llm import ask_chalk_ai

            context = prepare_context(panels)
            context["data_source"] = data_source

            response = ask_chalk_ai(question, context)
            if not isinstance(response, str) or not response.strip():
                raise RuntimeError("Empty LLM response.")

            ai_enabled = True
            processing_mode = "online"

        except Exception as exc:
            if mode == "online":
                raise RuntimeError(
                    f"Online processing unavailable: {type(exc).__name__}"
                ) from exc

            fallback_reason = type(exc).__name__

    if mode == "offline" or fallback_reason is not None:
        context = offline_context(panels, data_source)
        response = answer_question(
            question, context
        )["response"]
        ai_enabled = False
        processing_mode = "offline"

    return {
        "question": question,
        "response": response,
        "recommended_pairing": context["recommended_pairing"],
        "panel_passports": context["panel_passports"],
        "warnings": context["warnings"],
        "ai_enabled": ai_enabled,
        "processing_mode": processing_mode,
        "requested_mode": mode,
        "fallback_used": fallback_reason is not None,
        "fallback_reason": fallback_reason,
        "hardware_verified": hardware_verified,
        "data_source": data_source
    }


class Handler(BaseHTTPRequestHandler):
    def send_json(self, status, data):
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))

        origin = self.headers.get("Origin", "")
        allowed_origins = {
            "https://mscl741.github.io",
            "http://localhost:8000",
            "http://127.0.0.1:8000",
        }

        if origin in allowed_origins:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header(
                "Access-Control-Allow-Headers", "Content-Type"
            )
            self.send_header(
                "Access-Control-Allow-Methods", "GET, POST, OPTIONS"
            )

        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_json(200, {"ok": True})

    def do_GET(self):
        if self.path == "/health":
            self.send_json(200, {
                "status": "ok",
                "service": "solar-panel-advisor",
            })
        else:
            self.send_json(404, {"error": "Not found"})

    def do_POST(self):
        if self.path != "/advisor":
            self.send_json(404, {"error": "Not found"})
            return

        try:
            size = int(self.headers.get("Content-Length", "0"))

            if size <= 0 or size > 100000:
                raise ValueError("Invalid request size.")

            payload = json.loads(
                self.rfile.read(size).decode("utf-8")
            )

            if not isinstance(payload, dict):
                raise ValueError("Request must be a JSON object.")

            result = process_request(payload)
            self.send_json(200, result)

        except (ValueError, KeyError, TypeError) as exc:
            self.send_json(400, {"error": str(exc)})

        except RuntimeError as exc:
            self.send_json(503, {"error": str(exc)})

        except Exception:
            self.send_json(500, {
                "error": "Internal advisor error."
            })


if __name__ == "__main__":
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(
        f"Solar Panel Advisor API running at "
        f"http://{HOST}:{PORT}",
        flush=True
    )
    print("Press Ctrl+C to stop.", flush=True)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
