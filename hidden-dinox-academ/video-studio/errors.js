"use strict";
/* Единый тип ошибок обработки: code — машинный код, retryable — имеет ли смысл повторить задание */
class StudioError extends Error { constructor(code, message, retryable = false, extra) { super(message); this.code = code; this.retryable = retryable; this.extra = extra; } }
module.exports = { StudioError };
