"""Authenticated live USD/CNY rate service with bounded upstream access and caching."""
from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
import json
import math
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

from .errors import APIError


PRIMARY_URL = "https://open.er-api.com/v6/latest/USD"
FALLBACK_URL = "https://api.exchangerate-api.com/v4/latest/USD"
MAX_RESPONSE_BYTES = 512 * 1024
REQUEST_TIMEOUT_SECONDS = 8
FAILED_REFRESH_RETRY_SECONDS = 5 * 60
FALLBACK_RECHECK_SECONDS = 60 * 60
MAX_PUBLISHED_FUTURE_SECONDS = 10 * 60
MAX_PUBLICATION_AGE_SECONDS = 7 * 24 * 60 * 60
MAX_NEXT_UPDATE_AHEAD_SECONDS = 26 * 60 * 60
RATE_ADJUSTMENT = Decimal("0.02")


class NoRedirect(HTTPRedirectHandler):
    """Keep the fixed upstream request on its allowlisted host."""

    def redirect_request(self, _req, _fp, _code, _msg, _headers, _newurl):
        return None


class _UpstreamFailure(Exception):
    pass


def _iso_timestamp(epoch):
    if epoch is None:
        return None
    return datetime.fromtimestamp(epoch, timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _unix_timestamp(value):
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    # datetime.fromtimestamp has platform-specific limits. This range covers
    # normal provider dates while rejecting pathological values.
    if not math.isfinite(number) or not 946684800 <= number <= 4102444800:
        return None
    return number


def _date_timestamp(value):
    if not isinstance(value, str):
        return None
    try:
        return datetime.strptime(value, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp()
    except ValueError:
        return None


class ExchangeRateService:
    """Fetch one provider publication, then reuse it until the next release."""

    def __init__(self, opener=None, clock=None, timeout=REQUEST_TIMEOUT_SECONDS, max_response_bytes=MAX_RESPONSE_BYTES):
        self.opener = opener or build_opener(ProxyHandler({}), NoRedirect())
        self.clock = clock or time.time
        self.timeout = timeout
        self.max_response_bytes = max_response_bytes
        self._lock = threading.Lock()
        self._cache = None
        self._cache_stale = False
        self._refresh_after = 0.0
        self._retry_after = 0.0

    def get(self):
        """Return the current publication, coalescing concurrent refreshes."""
        # The lock intentionally spans the short upstream request. One caller
        # refreshes while concurrent callers wait and then consume its result.
        with self._lock:
            now = float(self.clock())
            if self._cache is not None and now < self._refresh_after:
                return self._result(cached=True, stale=False)
            if now < self._retry_after:
                if self._cache is not None:
                    return self._result(cached=True, stale=True)
                raise self._unavailable()

            try:
                value, refresh_after, source_stale = self._fetch(now)
            except _UpstreamFailure:
                if self._cache is None:
                    self._retry_after = now + FAILED_REFRESH_RETRY_SECONDS
                    raise self._unavailable() from None
                self._retry_after = now + FAILED_REFRESH_RETRY_SECONDS
                return self._result(cached=True, stale=True)

            self._cache = value
            self._cache_stale = source_stale
            self._refresh_after = refresh_after
            self._retry_after = 0.0
            return self._result(cached=False, stale=False)

    def _result(self, cached, stale):
        return {**self._cache, "cached": cached, "stale": stale or self._cache_stale}

    @staticmethod
    def _unavailable():
        return APIError(
            503,
            "EXCHANGE_RATE_UNAVAILABLE",
            "Live exchange rate is temporarily unavailable",
        )

    def _fetch(self, now):
        failures = []
        for url, source, schema in (
            (PRIMARY_URL, "open.er-api.com", "v6"),
            (FALLBACK_URL, "api.exchangerate-api.com", "v4"),
        ):
            try:
                data = self._request_json(url)
                return self._parse(data, source, schema, now)
            except (HTTPError, URLError, TimeoutError, OSError, UnicodeError, ValueError, _UpstreamFailure) as error:
                failures.append(error)
        raise _UpstreamFailure() from (failures[-1] if failures else None)

    def _request_json(self, url):
        request = Request(
            url,
            headers={"Accept": "application/json", "User-Agent": "Tradept exchange-rate gateway"},
            method="GET",
        )
        with self.opener.open(request, timeout=self.timeout) as response:
            if getattr(response, "status", 200) != 200:
                raise _UpstreamFailure()
            final_url = response.geturl() if hasattr(response, "geturl") else url
            if final_url != url:
                raise _UpstreamFailure()
            length = response.headers.get("Content-Length") if getattr(response, "headers", None) else None
            if length is not None:
                try:
                    if int(length) > self.max_response_bytes:
                        raise _UpstreamFailure()
                except ValueError:
                    raise _UpstreamFailure() from None
            body = response.read(self.max_response_bytes + 1)
        if len(body) > self.max_response_bytes:
            raise _UpstreamFailure()
        try:
            value = json.loads(
                body.decode("utf-8"),
                parse_constant=lambda _value: (_ for _ in ()).throw(ValueError("Nonfinite JSON")),
            )
        except (ValueError, UnicodeError):
            raise _UpstreamFailure() from None
        if not isinstance(value, dict):
            raise _UpstreamFailure()
        return value

    def _parse(self, data, source, schema, now):
        if schema == "v6":
            if data.get("result") != "success" or data.get("base_code") != "USD":
                raise _UpstreamFailure()
            published = _unix_timestamp(data.get("time_last_update_unix"))
            next_update = _unix_timestamp(data.get("time_next_update_unix"))
            if next_update is None:
                raise _UpstreamFailure()
        else:
            if data.get("base") != "USD":
                raise _UpstreamFailure()
            published = (
                _unix_timestamp(data.get("time_last_update_unix"))
                or _unix_timestamp(data.get("time_last_updated"))
                or _date_timestamp(data.get("date"))
            )
            next_update = _unix_timestamp(data.get("time_next_update_unix"))
            if next_update is None:
                expected = published + 24 * 60 * 60 if published is not None else now
                next_update = max(expected, now + FALLBACK_RECHECK_SECONDS)

        if (
            published is None
            or published > now + MAX_PUBLISHED_FUTURE_SECONDS
            or published < now - MAX_PUBLICATION_AGE_SECONDS
            or next_update <= published
            or next_update > now + MAX_NEXT_UPDATE_AHEAD_SECONDS
        ):
            raise _UpstreamFailure()

        rates = data.get("rates")
        if not isinstance(rates, dict):
            raise _UpstreamFailure()
        try:
            raw = Decimal(str(rates.get("CNY")))
        except (InvalidOperation, ValueError):
            raise _UpstreamFailure() from None
        if not raw.is_finite() or not Decimal("5") < raw < Decimal("10"):
            raise _UpstreamFailure()
        adjusted = (raw - RATE_ADJUSTMENT).quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP)
        fetched = now
        # Some provider edges briefly keep the old schedule after the announced
        # update. Mark that publication stale and retry once after a short
        # backoff rather than issuing one request per page hit.
        source_stale = next_update <= fetched
        refresh_after = fetched + FAILED_REFRESH_RETRY_SECONDS if source_stale else next_update
        return ({
            "base": "USD",
            "quote": "CNY",
            "rawRate": float(raw),
            "adjustment": -float(RATE_ADJUSTMENT),
            "adjustedRate": float(adjusted),
            "provider": "ExchangeRate-API",
            "source": source,
            "publishedAt": _iso_timestamp(published),
            "fetchedAt": _iso_timestamp(fetched),
            "nextUpdateAt": _iso_timestamp(next_update),
        }, refresh_after, source_stale)
