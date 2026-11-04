// Minimal stand-in for the NDI runtime, used only by the tests in CI/Linux
// where the real library can't be downloaded. Same C entry points and frame
// structs as the public NDI API; frames go through an in-process registry.
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <pthread.h>
#include <time.h>
#include <stdio.h>

typedef struct { const char *p_ndi_name; const char *p_url_address; } NDIlib_source_t;
typedef struct { bool show_local_sources; const char *p_groups; const char *p_extra_ips; } NDIlib_find_create_t;
typedef struct { NDIlib_source_t source_to_connect_to; int color_format; int bandwidth; bool allow_video_fields; const char *p_ndi_recv_name; } NDIlib_recv_create_v3_t;
typedef struct { int xres, yres; uint32_t FourCC; int frame_rate_N, frame_rate_D; float picture_aspect_ratio; int frame_format_type; int64_t timecode; uint8_t *p_data; int line_stride_in_bytes; const char *p_metadata; int64_t timestamp; } NDIlib_video_frame_v2_t;
typedef struct { int sample_rate, no_channels, no_samples; int64_t timecode; float *p_data; int channel_stride_in_bytes; const char *p_metadata; int64_t timestamp; } NDIlib_audio_frame_v2_t;
typedef struct { int length; int64_t timecode; char *p_data; } NDIlib_metadata_frame_t;
typedef struct { const char *p_ndi_name; const char *p_groups; bool clock_video; bool clock_audio; } NDIlib_send_create_t;
typedef struct { bool on_program; bool on_preview; } NDIlib_tally_t;

#define MAXS 16
typedef struct {
  int used; char name[256];
  uint8_t *video; int vw, vh, vstride, vseq; uint32_t fourcc; int fn, fd;
  float *audio; int arate, ach, asamples, aseq;
  NDIlib_tally_t tally; int receivers;
} slot_t;
static slot_t slots[MAXS];
static pthread_mutex_t mu = PTHREAD_MUTEX_INITIALIZER;
static NDIlib_source_t found[MAXS];

typedef struct { int slot; int vseen, aseen; NDIlib_tally_t tally; } recv_t;

bool NDIlib_initialize(void) { return true; }
void NDIlib_destroy(void) {}
const char *NDIlib_version(void) { return "NDI mock 6.0 (tests)"; }

void *NDIlib_send_create(const NDIlib_send_create_t *c) {
  pthread_mutex_lock(&mu);
  for (int i = 0; i < MAXS; i++) if (!slots[i].used) {
    memset(&slots[i], 0, sizeof(slot_t));
    slots[i].used = 1;
    snprintf(slots[i].name, sizeof slots[i].name, "MOCKHOST (%s)", c && c->p_ndi_name ? c->p_ndi_name : "sender");
    pthread_mutex_unlock(&mu);
    return &slots[i];
  }
  pthread_mutex_unlock(&mu);
  return NULL;
}
void NDIlib_send_destroy(void *s) {
  pthread_mutex_lock(&mu);
  slot_t *sl = s; free(sl->video); free(sl->audio); memset(sl, 0, sizeof(slot_t));
  pthread_mutex_unlock(&mu);
}
void NDIlib_send_send_video_v2(void *s, const NDIlib_video_frame_v2_t *f) {
  slot_t *sl = s;
  pthread_mutex_lock(&mu);
  size_t n = (size_t)f->line_stride_in_bytes * f->yres;
  sl->video = realloc(sl->video, n); memcpy(sl->video, f->p_data, n);
  sl->vw = f->xres; sl->vh = f->yres; sl->vstride = f->line_stride_in_bytes; sl->fourcc = f->FourCC;
  sl->fn = f->frame_rate_N; sl->fd = f->frame_rate_D; sl->vseq++;
  pthread_mutex_unlock(&mu);
}
void NDIlib_send_send_audio_v2(void *s, const NDIlib_audio_frame_v2_t *f) {
  slot_t *sl = s;
  pthread_mutex_lock(&mu);
  size_t n = (size_t)f->channel_stride_in_bytes * f->no_channels;
  sl->audio = realloc(sl->audio, n); memcpy(sl->audio, f->p_data, n);
  sl->arate = f->sample_rate; sl->ach = f->no_channels; sl->asamples = f->no_samples; sl->aseq++;
  pthread_mutex_unlock(&mu);
}
int NDIlib_send_get_no_connections(void *s, uint32_t t) { (void)t; return ((slot_t *)s)->receivers; }
bool NDIlib_send_get_tally(void *s, NDIlib_tally_t *t, uint32_t to) { (void)to; *t = ((slot_t *)s)->tally; return true; }

void *NDIlib_find_create_v2(const NDIlib_find_create_t *c) { (void)c; return malloc(1); }
void NDIlib_find_destroy(void *f) { free(f); }
bool NDIlib_find_wait_for_sources(void *f, uint32_t ms) { (void)f; struct timespec ts = { 0, (long)(ms > 50 ? 50 : ms) * 1000000L }; nanosleep(&ts, NULL); return true; }
const NDIlib_source_t *NDIlib_find_get_current_sources(void *f, uint32_t *n) {
  (void)f; uint32_t k = 0;
  pthread_mutex_lock(&mu);
  for (int i = 0; i < MAXS; i++) if (slots[i].used) { found[k].p_ndi_name = slots[i].name; found[k].p_url_address = "127.0.0.1:5961"; k++; }
  pthread_mutex_unlock(&mu);
  *n = k; return found;
}

void *NDIlib_recv_create_v3(const NDIlib_recv_create_v3_t *c) {
  pthread_mutex_lock(&mu);
  for (int i = 0; i < MAXS; i++) if (slots[i].used && c->source_to_connect_to.p_ndi_name && !strcmp(slots[i].name, c->source_to_connect_to.p_ndi_name)) {
    recv_t *r = calloc(1, sizeof(recv_t)); r->slot = i; slots[i].receivers++;
    pthread_mutex_unlock(&mu); return r;
  }
  pthread_mutex_unlock(&mu);
  return NULL;
}
void NDIlib_recv_destroy(void *r) { pthread_mutex_lock(&mu); slots[((recv_t *)r)->slot].receivers--; pthread_mutex_unlock(&mu); free(r); }
int NDIlib_recv_get_no_connections(void *r) { (void)r; return 1; }
bool NDIlib_recv_set_tally(void *r, const NDIlib_tally_t *t) {
  pthread_mutex_lock(&mu); slots[((recv_t *)r)->slot].tally = *t; pthread_mutex_unlock(&mu); return true;
}
int NDIlib_recv_capture_v2(void *rp, NDIlib_video_frame_v2_t *v, NDIlib_audio_frame_v2_t *a, NDIlib_metadata_frame_t *m, uint32_t ms) {
  (void)m; recv_t *r = rp;
  for (uint32_t waited = 0; waited <= ms; waited += 5) {
    pthread_mutex_lock(&mu);
    slot_t *sl = &slots[r->slot];
    if (v && sl->vseq != r->vseen && sl->video) {
      r->vseen = sl->vseq;
      // receivers ask for BGRX_BGRA: swap R/B of RGBA input, add 64 bytes of row padding
      int stride = sl->vw * 4 + 64;
      uint8_t *out = calloc((size_t)stride * sl->vh, 1);
      for (int y = 0; y < sl->vh; y++) for (int x = 0; x < sl->vw; x++) {
        uint8_t *s = sl->video + y * sl->vstride + x * 4, *d = out + y * stride + x * 4;
        d[0] = s[2]; d[1] = s[1]; d[2] = s[0]; d[3] = s[3];
      }
      v->xres = sl->vw; v->yres = sl->vh; v->FourCC = 'B' | 'G' << 8 | 'R' << 16 | 'A' << 24; v->frame_rate_N = sl->fn; v->frame_rate_D = sl->fd;
      v->p_data = out; v->line_stride_in_bytes = stride; v->frame_format_type = 1;
      pthread_mutex_unlock(&mu); return 1;
    }
    if (a && sl->aseq != r->aseen && sl->audio) {
      r->aseen = sl->aseq;
      size_t n = (size_t)sl->asamples * 4 * sl->ach;
      a->p_data = malloc(n); memcpy(a->p_data, sl->audio, n);
      a->sample_rate = sl->arate; a->no_channels = sl->ach; a->no_samples = sl->asamples; a->channel_stride_in_bytes = sl->asamples * 4;
      pthread_mutex_unlock(&mu); return 2;
    }
    pthread_mutex_unlock(&mu);
    struct timespec ts = { 0, 5000000L }; nanosleep(&ts, NULL);
  }
  return 0;
}
void NDIlib_recv_free_video_v2(void *r, const NDIlib_video_frame_v2_t *v) { (void)r; free(v->p_data); }
void NDIlib_recv_free_audio_v2(void *r, const NDIlib_audio_frame_v2_t *a) { (void)r; free(a->p_data); }
void NDIlib_recv_free_metadata(void *r, const NDIlib_metadata_frame_t *m) { (void)r; (void)m; }
