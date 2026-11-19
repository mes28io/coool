// coool's thin C layer over whisper.cpp: the few calls the app makes, with plain arguments, so the Rust side never
// mirrors whisper.cpp's large parameter structs (their layout changes between releases).

#include <stdbool.h>
#include <stddef.h>
#include <string.h>

#include "ggml.h"
#include "whisper.h"

typedef void (*coool_segment_cb)(const char *text, void *user);

static void quiet_log(enum ggml_log_level level, const char *text, void *user) {
    (void)level;
    (void)text;
    (void)user;
}

static int g_verbose = 0;

// whisper.cpp and ggml print to stderr by default; coool keeps them quiet unless asked (COOOL_WHISPER_LOG=1).
void coool_whisper_set_verbose(int on) {
    g_verbose = on;
    whisper_log_set(on ? NULL : quiet_log, NULL);
    ggml_log_set(on ? NULL : quiet_log, NULL);
}

struct whisper_context *coool_whisper_load(const char *path, int use_gpu, int flash_attn) {
    if (!g_verbose) coool_whisper_set_verbose(0);
    struct whisper_context_params cp = whisper_context_default_params();
    cp.use_gpu = use_gpu != 0;
    cp.flash_attn = flash_attn != 0;
    return whisper_init_from_file_with_params(path, cp);
}

void coool_whisper_free(struct whisper_context *ctx) {
    if (ctx) whisper_free(ctx);
}

int coool_whisper_is_multilingual(struct whisper_context *ctx) { return whisper_is_multilingual(ctx); }

struct cb_bridge {
    coool_segment_cb cb;
    void *user;
};

static void on_segment(struct whisper_context *ctx, struct whisper_state *state, int n_new, void *user) {
    (void)state;
    struct cb_bridge *b = (struct cb_bridge *)user;
    if (!b || !b->cb) return;
    const int n = whisper_full_n_segments(ctx);
    for (int i = n - n_new; i < n; i++) {
        const char *t = whisper_full_get_segment_text(ctx, i);
        if (t) b->cb(t, b->user);
    }
}

static bool on_abort(void *user) {
    volatile int *flag = (volatile int *)user;
    return flag && *flag != 0;
}

// Runs one utterance. `language`: a whisper language code, or NULL / "" / "auto" to detect it. `translate`: English
// out whatever went in. `audio_ctx`: 0 for whisper's full 30 s window, or fewer encoder frames for a short clip.
// Returns 0 on success; the text is then read with coool_whisper_n_segments / coool_whisper_segment.
int coool_whisper_run(struct whisper_context *ctx, const float *samples, int n_samples, const char *language, int translate,
                      int threads, const char *initial_prompt, int audio_ctx, coool_segment_cb cb, void *user,
                      volatile int *abort_flag) {
    struct whisper_full_params p = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
    p.n_threads = threads > 0 ? threads : 4;
    p.translate = translate != 0;
    p.no_context = true;
    p.no_timestamps = true;
    p.single_segment = false;
    p.print_special = false;
    p.print_progress = false;
    p.print_realtime = false;
    p.print_timestamps = false;
    p.suppress_blank = true;
    p.suppress_nst = true;
    p.audio_ctx = audio_ctx > 0 ? audio_ctx : 0;
    const bool detect = language == NULL || language[0] == '\0' || strcmp(language, "auto") == 0;
    p.language = detect ? "auto" : language;
    p.detect_language = false;
    p.initial_prompt = (initial_prompt && initial_prompt[0]) ? initial_prompt : NULL;
    struct cb_bridge bridge = {cb, user};
    if (cb) {
        p.new_segment_callback = on_segment;
        p.new_segment_callback_user_data = &bridge;
    }
    if (abort_flag) {
        p.abort_callback = on_abort;
        p.abort_callback_user_data = (void *)abort_flag;
    }
    return whisper_full(ctx, p, samples, n_samples);
}

int coool_whisper_n_segments(struct whisper_context *ctx) { return whisper_full_n_segments(ctx); }

const char *coool_whisper_segment(struct whisper_context *ctx, int i) { return whisper_full_get_segment_text(ctx, i); }

// The language whisper heard in the last run ("tr", "de" …), or "" when unknown.
const char *coool_whisper_detected_language(struct whisper_context *ctx) {
    const int id = whisper_full_lang_id(ctx);
    if (id < 0) return "";
    const char *s = whisper_lang_str(id);
    return s ? s : "";
}

const char *coool_whisper_system_info(void) { return whisper_print_system_info(); }
