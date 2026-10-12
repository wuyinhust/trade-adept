"""Public API failures, without upstream traces or credentials."""


class APIError(Exception):
    def __init__(self, status, code, message, **details):
        super().__init__(message)
        self.status, self.code, self.details = status, code, details

    def response(self):
        return {"error": str(self), "code": self.code, **self.details}
