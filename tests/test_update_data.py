"""Unit tests for scripts/update_data.py. No network: inputs are small samples.

Run with: python3 -m unittest discover -s tests
"""

import json
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET
from datetime import date, datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import update_data as u  # noqa: E402


class Base(unittest.TestCase):
    def setUp(self):
        u.alerts.clear()


class ParseStart(Base):
    def test_summer_offset(self):
        self.assertEqual(u.parse_start("2026-09-30T00:01-04"), datetime(2026, 9, 30, 4, 1, tzinfo=timezone.utc))

    def test_winter_offset(self):
        self.assertEqual(u.parse_start("2026-12-01T00:01-05"), datetime(2026, 12, 1, 5, 1, tzinfo=timezone.utc))

    def test_no_offset_is_utc(self):
        self.assertEqual(u.parse_start("2026-09-30T10:00"), datetime(2026, 9, 30, 10, 0, tzinfo=timezone.utc))


class Schedule(Base):
    def schedule(self, *appointments):
        xml = "<MapSchedule><appointments>" + "".join(
            f'<appointment map="{m}" start="{s}" />' for m, s in appointments
        ) + "</appointments></MapSchedule>"
        return u.build_schedule(ET.fromstring(xml))

    def test_pairs_and_sorting(self):
        result = self.schedule(("FRANCE", "2099-01-03T00:01-05"), ("SCOTLAND", "2099-01-01T00:01-05"))
        self.assertEqual([a["map"] for a in result["appointments"]], ["SCOTLAND", "FRANCE"])
        self.assertEqual(result["appointments"][0]["worlds"], ["SCOTLAND", "MAKURIISLANDS"])
        self.assertEqual(result["appointments"][1]["worlds"], ["FRANCE", "PARIS"])
        self.assertEqual(result["alwaysActive"], ["WATOPIA"])
        self.assertEqual(u.alerts, [])

    def test_unknown_world_alerts_but_still_works(self):
        result = self.schedule(("NEWPLACE", "2099-01-01T00:01-05"))
        self.assertEqual(result["appointments"][0]["worlds"], ["NEWPLACE"])
        self.assertTrue(any("NEWPLACE" in a for a in u.alerts))

    def test_empty_schedule_is_an_error(self):
        with self.assertRaises(ValueError):
            self.schedule()

    def test_runway_alert(self):
        appointments = [{"start": "2026-10-31T04:01:00Z"}]
        u.check_schedule_runway(appointments, datetime(2026, 10, 28, 12, tzinfo=timezone.utc))
        self.assertEqual(u.alerts, [])
        u.check_schedule_runway(appointments, datetime(2026, 10, 29, 12, tzinfo=timezone.utc))
        self.assertEqual(len(u.alerts), 1)


class Routes(Base):
    def dictionary(self, extra="", count=110):
        rows = "".join(
            f'<ROUTE name="Route {i}" map="WATOPIA" signature="{1000 + i}" distanceInMeters="{10000 + i}" '
            f'ascentInMeters="100" leadinDistanceInMeters="500" leadinAscentInMeters="5" sports="1" '
            f'eventOnly="0" levelLocked="0" supportedLaps="1" />'
            for i in range(count)
        )
        return ET.fromstring(f"<GameDictionary><ROUTES>{rows}{extra}</ROUTES></GameDictionary>")

    def test_fields_and_portal_entries_skipped(self):
        extra = (
            '<ROUTE name="Road to Sky" map="WATOPIA" signature="5" distanceInMeters="17495.6" ascentInMeters="1044.3" '
            'leadinDistanceInMeters="103.4" leadinAscentInMeters="0" sports="3" eventOnly="0" levelLocked="1" '
            'supportedLaps="0" publishedOn="2026-07-06" />'
            '<ROUTE name="Portal Climb" map="" signature="6" sports="7" />'
        )
        routes = u.build_routes(self.dictionary(extra))["routes"]
        self.assertNotIn("Portal Climb", [r["name"] for r in routes])
        sky = next(r for r in routes if r["name"] == "Road to Sky")
        self.assertEqual(sky["id"], "5")
        self.assertTrue(sky["cycling"] and sky["running"] and sky["levelLocked"])
        self.assertFalse(sky["loop"])
        self.assertEqual(sky["publishedOn"], "2026-07-06")
        self.assertEqual(sky["ascentMeters"], 1044.3)

    def test_too_few_routes_is_an_error(self):
        with self.assertRaises(ValueError):
            u.build_routes(self.dictionary(count=3))


class Order(Base):
    def setUp(self):
        super().setUp()
        self.real_data_dir = u.DATA_DIR

    def tearDown(self):
        u.DATA_DIR = self.real_data_dir

    def test_append_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            u.DATA_DIR = Path(tmp)
            first = [{"id": "30"}, {"id": "10"}, {"id": "20"}]
            self.assertEqual(u.update_order(first), ["10", "20", "30"])
            # One route removed, one added: existing positions never move.
            second = [{"id": "10"}, {"id": "30"}, {"id": "5"}]
            (Path(tmp) / u.ORDER_FILE).write_text(json.dumps(["10", "20", "30"]))
            order = u.update_order(second)
            self.assertEqual(order, ["10", "20", "30", "5"])
            self.assertEqual({r["id"]: r["index"] for r in second}, {"10": 0, "30": 2, "5": 3})


class Links(Base):
    def test_slugify(self):
        self.assertEqual(u.slugify("Champs-Élysées"), "champs-elysees")
        self.assertEqual(u.slugify("Queen's Highway"), "queens-highway")
        self.assertEqual(u.slugify("Col du Galibier (Lautaret)"), "col-du-galibier-lautaret")

    def test_candidates(self):
        self.assertEqual(u.link_candidates("Road to Sky Run"), ["Road to Sky Run", "Road to Sky"])
        self.assertEqual(u.link_candidates("Watopia Figure 8"), ["Watopia Figure 8", "Figure 8"])
        self.assertEqual(u.link_candidates("Tempus Fugit"), ["Tempus Fugit"])


class Weekly(Base):
    LEGEND = (
        '<tr data-category="370"><td class="cat-key-cell"></td><td class="cat-key-cell" data-category="370">&nbsp;Climb of the Week</td></tr>'
        '<tr data-category="367"><td class="cat-key-cell"></td><td class="cat-key-cell" data-category="367">&nbsp;Route of the Week</td></tr>'
        '<tr data-category="369"><td class="cat-key-cell"></td><td class="cat-key-cell" data-category="369">&nbsp;Workout of the Week</td></tr>'
    )

    @staticmethod
    def event(category, title, link):
        return (
            f'<span class="calnk category_{category} category-bg"><span class="calnk-link"><span class="calnk-box">'
            f'<a href="{link}"><span class="spiffy-title">{title}</span></a></span></span></span>'
        )

    def page(self, days, legend=True):
        cells = "".join(f'<td class="spiffy-day-{d}  day-with-date"><span class="day-number">{d}</span>{body}</td>' for d, body in days)
        return f"<table>{self.LEGEND if legend else ''}</table><table>{cells}</table>"

    def test_parse_month(self):
        body = (self.event(370, "M&ucirc;r de Bretagne (15k Drops)", "https://zwiftinsider.com/portal/mur/")
                + self.event(367, "Loop de Loop (15k Drops)", "https://zwiftinsider.com/route/loop-de-loop/")
                + self.event(369, "Some Workout (50 XP)", "https://example.com/"))
        days = u.parse_weekly_month(self.page([(5, body), (6, "")]), 2026, 10)
        self.assertEqual(list(days), [date(2026, 10, 5)])
        self.assertEqual(days[date(2026, 10, 5)]["route"], ("Loop de Loop (15k Drops)", "https://zwiftinsider.com/route/loop-de-loop/"))
        self.assertEqual(days[date(2026, 10, 5)]["climb"][0], "Mûr de Bretagne (15k Drops)")
        self.assertNotIn("workout", days[date(2026, 10, 5)])

    def test_missing_legend_is_an_error(self):
        with self.assertRaises(ValueError):
            u.parse_weekly_month(self.page([], legend=False), 2026, 10)

    def test_split_reward(self):
        self.assertEqual(u.split_reward("Volcano Flat (250 XP)"), ("Volcano Flat", "250 XP"))
        self.assertEqual(u.split_reward("Crow Road (15k Drops)"), ("Crow Road", "15k Drops"))
        self.assertEqual(u.split_reward("Col du Galibier (Lautaret) (500 XP)"), ("Col du Galibier (Lautaret)", "500 XP"))
        self.assertEqual(u.split_reward("No Reward"), ("No Reward", None))


class Portal(Base):
    def portal(self, appointments):
        xml = (
            '<PortalRoads><PortalRoadMetadataCollections>'
            '<PortalRoadMetadata name="Rocacorba" id="10017" distanceCentimeters="1183120" elevCentimeters="75620"/>'
            '<PortalRoadMetadata name="Unused" id="99999" distanceCentimeters="100" elevCentimeters="100"/>'
            '</PortalRoadMetadataCollections><appointments>' + appointments + '</appointments></PortalRoads>'
        )
        return u.build_portal(ET.fromstring(xml))

    def test_climbs_and_schedule(self):
        result = self.portal(
            '<appointment road="10017" world="1" portal="0" start="2026-09-30T00:01-04"/>'
            '<appointment road="10017" world="10" portal_of_month="true" portal="0" start="2026-10-01T00:01-04"/>'
        )
        self.assertEqual(list(result["climbs"]), ["10017"])  # unscheduled climbs are dropped
        self.assertEqual(result["climbs"]["10017"], {"name": "Rocacorba", "distanceMeters": 11831.2, "ascentMeters": 756.2})
        self.assertEqual(result["schedule"][0], {"start": "2026-09-30T04:01:00Z", "world": "WATOPIA", "monthly": False, "climbId": "10017"})
        self.assertTrue(result["schedule"][1]["monthly"])
        self.assertEqual(result["schedule"][1]["world"], "FRANCE")

    def test_unknown_world_alerts_and_is_skipped(self):
        result = self.portal(
            '<appointment road="10017" world="1" portal="0" start="2026-09-30T00:01-04"/>'
            '<appointment road="10017" world="42" portal="0" start="2026-09-30T00:01-04"/>'
        )
        self.assertEqual(len(result["schedule"]), 1)
        self.assertTrue(any("42" in a for a in u.alerts))

    def test_unknown_climb_is_an_error(self):
        with self.assertRaises(ValueError):
            self.portal('<appointment road="55555" world="1" portal="0" start="2026-09-30T00:01-04"/>')


if __name__ == "__main__":
    unittest.main()
