"""Refresh the last valid daily rate snapshot for the Atlas pilot."""
from datetime import date, datetime, timedelta, timezone
import json
import math
from pathlib import Path
from time import sleep
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

NRB = "https://www.nrb.org.np/api/forex/v1/rates"
TRM = "https://www.datos.gov.co/resource/32sa-8pi3.json"
CURRENCIES = ("EUR", "USD", "GBP", "INR")
ROOT = Path(__file__).resolve().parents[2]
SNAPSHOT = ROOT / "piloto/assets/exchange-rates.json"


def fetch_json(endpoint, params):
    request = Request(endpoint + "?" + urlencode(params), headers={
        "Accept": "application/json",
        "User-Agent": "Atlas-de-Billetes/1.0",
    })
    for attempt in range(3):
        try:
            with urlopen(request, timeout=20) as response:
                return json.load(response)
        except (OSError, ValueError) as error:
            if attempt == 2:
                raise RuntimeError(f"No data received from {endpoint}: {error}") from error
            sleep(2 ** attempt)


def positive(value):
    number = float(value)
    if not math.isfinite(number) or number <= 0:
        raise ValueError(f"Invalid exchange rate or unit: {value!r}")
    return number


def get_nepal(today):
    result = fetch_json(NRB, {
        "page": 1,
        "per_page": 8,
        "from": (today - timedelta(days=7)).isoformat(),
        "to": today.isoformat(),
    })
    days = result["data"]["payload"]
    entry = max((day for day in days if date.fromisoformat(day["date"]) <= today), key=lambda day: day["date"])
    reported = {item["currency"]["iso3"].upper(): item for item in entry["rates"]}
    return {
        "date": entry["date"],
        "rates": {
            code: {
                "unit": positive(reported[code]["currency"]["unit"]),
                "sell": positive(reported[code]["sell"]),
            }
            for code in CURRENCIES
        },
    }


def get_colombia(today):
    point = today.isoformat() + "T00:00:00.000"
    rows = fetch_json(TRM, {
        "$select": "valor,vigenciadesde,vigenciahasta",
        "$where": f"vigenciadesde <= '{point}' AND vigenciahasta >= '{point}'",
        "$order": "vigenciadesde DESC",
        "$limit": 1,
    })
    entry = rows[0]
    start = date.fromisoformat(entry["vigenciadesde"][:10])
    through = date.fromisoformat(entry["vigenciahasta"][:10])
    if not start <= today <= through:
        raise ValueError("Colombian TRM does not cover the date requested")
    return {
        "copPerUsd": positive(entry["valor"]),
        "validFrom": start.isoformat(),
        "validThrough": through.isoformat(),
    }


def refresh(path, now):
    current = json.loads(path.read_text(encoding="utf-8"))
    nepal = now.astimezone(ZoneInfo("Asia/Kathmandu")).date()
    colombia = now.astimezone(ZoneInfo("America/Bogota")).date()
    new = {"npr": get_nepal(nepal), "cop": get_colombia(colombia)}
    if new["npr"]["date"] < current["npr"]["date"] or new["cop"]["validFrom"] < current["cop"]["validFrom"]:
        raise ValueError("The sources returned older rates. The existing snapshot was preserved.")
    if new != current:
        temporary = path.with_suffix(".tmp")
        temporary.write_text(json.dumps(new, indent=2) + "\n", encoding="utf-8")
        temporary.replace(path)
    print(f"Nepal: {new['npr']['date']}. Colombia: {new['cop']['validFrom']} to {new['cop']['validThrough']}.")


if __name__ == "__main__":
    refresh(SNAPSHOT, datetime.now(timezone.utc))
