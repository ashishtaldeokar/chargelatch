#include <math.h>
#include <stdarg.h>
#include <stdio.h>

#include "sdm_json.h"

/* Appends to out[*len]; returns false (leaving *len alone) if it does not fit. */
static bool append(char *out, size_t size, size_t *len, const char *format, ...)
{
    va_list args;
    va_start(args, format);
    const int written = vsnprintf(out + *len, size - *len, format, args);
    va_end(args);
    if (written < 0 || (size_t)written >= size - *len) {
        return false;
    }
    *len += (size_t)written;
    return true;
}

size_t sdm_json_format(const sdm_model_t *model, const float *values, const bool *valid, const char *error,
                       char *out, size_t size)
{
    if (size == 0) {
        return 0;
    }

    bool complete = true;
    for (size_t i = 0; i < model->register_count; i++) {
        complete = complete && valid[i] && isfinite(values[i]);
    }

    size_t len = 0;
    if (!append(out, size, &len, "{\"model\":\"%s\",\"phases\":%u,\"ok\":%s", model->name, (unsigned)model->phases,
                complete ? "true" : "false")) {
        return 0;
    }
    if (!complete && !append(out, size, &len, ",\"error\":\"%s\"", error ? error : "invalid_value")) {
        return 0;
    }
    for (size_t i = 0; i < model->register_count; i++) {
        if (!valid[i] || !isfinite(values[i])) {
            continue;
        }
        if (!append(out, size, &len, ",\"%s\":%.3f", model->registers[i].key, (double)values[i])) {
            return 0;
        }
    }
    return append(out, size, &len, "}") ? len : 0;
}
