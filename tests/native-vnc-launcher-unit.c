/* Pure negative unit tests. Every boundary reached here is a local stub. This
 * executable never invokes the launcher, setpriv, x11vnc or close_range. */
#define _GNU_SOURCE
#include <errno.h>
#include <dirent.h>
#include <fcntl.h>
#include <setjmp.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <unistd.h>

static jmp_buf rejected;
static int calls, exec_calls, close_calls, harden_fault, filter_fault, filtered_fault;
static int borrowed_fault;
static char last_error[128];
static size_t filter_offset;
static int fake_dprintf(int fd, const char *format, ...);
static void fake_exit(int code) __attribute__((noreturn));
static char *fake_realpath(const char *name, char *resolved);
static int fake_setrlimit(__rlimit_resource_t resource, const struct rlimit *limit);
static int fake_getrlimit(__rlimit_resource_t resource, struct rlimit *limit);
static int fake_prctl(int operation, ...);
static long fake_syscall(long number, ...);
static int fake_execve(const char *path, char *const args[], char *const env[]);
static int fake_openat(int base, const char *name, int flags, ...);
static int fake_open(const char *name, int flags, ...);
static DIR *fake_opendir(const char *name);
static struct dirent *fake_readdir(DIR *dir);
static int fake_closedir(DIR *dir);
static int fake_dirfd(DIR *dir);
static int fake_fstat(int fd, struct stat *st);
static ssize_t fake_read(int fd, void *buffer, size_t length);
static int fake_close(int fd);
static uid_t fake_geteuid(void);
static int fake_clock_gettime(clockid_t clock, struct timespec *now);

#define dprintf fake_dprintf
#define _exit fake_exit
#define realpath fake_realpath
#define setrlimit fake_setrlimit
#define getrlimit fake_getrlimit
#define prctl fake_prctl
#define syscall fake_syscall
#define execve fake_execve
#define openat fake_openat
#define open fake_open
#define opendir fake_opendir
#define readdir fake_readdir
#define closedir fake_closedir
#define dirfd fake_dirfd
#define fstat fake_fstat
#define read fake_read
#define close fake_close
#define geteuid fake_geteuid
#define clock_gettime fake_clock_gettime
#define main launcher_main
#include "../src/computer/native/vnc-launcher.c"
#undef main

static int fake_dprintf(int fd, const char *format, ...) {
  if (fd != 2) abort();
  va_list ap;
  va_start(ap, format);
  int n = vsnprintf(last_error, sizeof(last_error), format, ap);
  va_end(ap);
  return n;
}
static void fake_exit(int code) { if (code != 126) abort(); longjmp(rejected, 1); }
static char *fake_realpath(const char *name, char *resolved) {
  if (strcmp(name, "/mock/private") && strcmp(name, "/mock/external") &&
      strcmp(name, "/mock/external/Xauthority") &&
      strcmp(name, "/mock/external-link") &&
      strcmp(name, "/mock/external/Xauthority-link")) return NULL;
  if (!strcmp(name, "/mock/external-link")) strcpy(resolved, "/mock/external");
  else if (!strcmp(name, "/mock/external/Xauthority-link"))
    strcpy(resolved, "/mock/external/Xauthority");
  else strcpy(resolved, name);
  return resolved;
}
static int fake_setrlimit(__rlimit_resource_t resource, const struct rlimit *limit) {
  ++calls;
  if (harden_fault == 1 || (harden_fault == 2 && resource == RLIMIT_FSIZE)) {
    errno = EPERM; return -1;
  }
  if (resource == RLIMIT_CORE && (limit->rlim_cur || limit->rlim_max)) abort();
  if (resource == RLIMIT_FSIZE && (limit->rlim_cur != 65536 || limit->rlim_max != 65536)) abort();
  return 0;
}
static int fake_getrlimit(__rlimit_resource_t resource, struct rlimit *limit) {
  ++calls;
  if (harden_fault == 4) { errno = EIO; return -1; }
  limit->rlim_cur = resource == RLIMIT_CORE ? (filtered_fault == 4 ? 1 : 0) : 65536;
  limit->rlim_max = limit->rlim_cur;
  return 0;
}
static int fake_prctl(int operation, ...) {
  ++calls;
  if (harden_fault == 3 && operation == PR_SET_DUMPABLE) { errno = EPERM; return -1; }
  if (operation == PR_GET_DUMPABLE) return 0;
  if (operation == PR_SET_DUMPABLE) return 0;
  if (operation == PR_GET_NO_NEW_PRIVS) return filtered_fault == 1 ? 0 : 1;
  if (operation == PR_GET_SECCOMP) return filtered_fault == 2 ? 0 : 2;
  abort();
}
static long fake_syscall(long number, ...) {
  ++close_calls;
  va_list ap;
  va_start(ap, number);
  unsigned int first = va_arg(ap, unsigned int);
  unsigned int last = va_arg(ap, unsigned int);
  unsigned int flags = va_arg(ap, unsigned int);
  va_end(ap);
  if (number != SYS_close_range || first != 3U || last != ~0U || flags) abort();
  errno = ENOSYS;
  return -1;
}
static int fake_execve(const char *path, char *const args[], char *const env[]) {
  ++exec_calls;
  if (strcmp(path, "/usr/bin/setpriv") || strcmp(args[0], path) ||
      strcmp(args[1], "--no-new-privs") || strcmp(args[2], "--seccomp-filter") ||
      strcmp(args[4], "--") || !env) abort();
  errno = ENOEXEC;
  return -1;
}
static int fake_openat(int base, const char *name, int flags, ...) {
  if (base == 80 && !strcmp(name, "Xauthority")) {
    if ((flags & (O_RDONLY | O_CLOEXEC | O_NOFOLLOW)) != (O_CLOEXEC | O_NOFOLLOW)) abort();
    return 81;
  }
  (void)flags;
  ++calls;
  if (strcmp(name, "rfb.seccomp")) abort();
  if (filter_fault == 3) { errno = ENOENT; return -1; }
  filter_offset = 0;
  return 77;
}
static size_t proc_offset;
static int fake_open(const char *name, int flags, ...) {
  if (!strcmp(name, "/mock/external")) {
    if ((flags & (O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)) !=
        (O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)) abort();
    return 80;
  }
  proc_offset = 0;
  if (!strcmp(name, "/proc/self/status")) return 78;
  if (!strcmp(name, "/proc/self/limits")) return 79;
  abort();
}
static int inventory_index, leaked_fd;
static DIR *fake_opendir(const char *name) {
  if (strcmp(name, "/proc/self/fd")) abort();
  inventory_index = 0;
  return (DIR *)(uintptr_t)1;
}
static struct dirent *fake_readdir(DIR *dir) {
  if (dir != (DIR *)(uintptr_t)1) abort();
  static struct dirent entry;
  const char *names[] = {".", "..", "0", "1", "2", "9", "20", "21"};
  int length = leaked_fd ? 8 : 7;
  if (inventory_index == length) return NULL;
  strcpy(entry.d_name, names[inventory_index++]);
  return &entry;
}
static int fake_closedir(DIR *dir) { if (dir != (DIR *)(uintptr_t)1) abort(); return 0; }
static int fake_dirfd(DIR *dir) { if (dir != (DIR *)(uintptr_t)1) abort(); return 20; }
static int fake_fstat(int fd, struct stat *st) {
  memset(st, 0, sizeof(*st));
  if (fd == 80) {
    st->st_mode = S_IFDIR | (borrowed_fault == 4 ? 0755 : 0700);
    st->st_uid = borrowed_fault == 5 ? 994 : 993;
    st->st_gid = borrowed_fault == 6 ? 983 : 982;
    return 0;
  }
  if (fd == 81) {
    st->st_mode = S_IFREG | (borrowed_fault == 7 ? 0644 : 0600);
    st->st_uid = borrowed_fault == 1 ? 994 : 993;
    st->st_gid = borrowed_fault == 2 ? 983 : 982;
    st->st_dev = borrowed_fault == 9 ? 56 : 55;
    st->st_ino = borrowed_fault == 3 ? 78 : 77;
    st->st_nlink = borrowed_fault == 8 ? 2 : 1;
    return 0;
  }
  if (fd != 77) abort();
  st->st_mode = S_IFREG | (filter_fault == 2 ? 0644 : 0600);
  st->st_uid = 1000;
  st->st_nlink = 1;
  st->st_size = sizeof(reviewed_filter);
  return 0;
}
static ssize_t fake_read(int fd, void *buffer, size_t length) {
  if (fd == 78 || fd == 79) {
    const char *contents = fd == 78 ?
      (filtered_fault == 3 ? "Seccomp_filters:\t1\n" : "Seccomp_filters:\t2\n") :
      "Max core file size        0                    0                    bytes\n";
    size_t remaining = strlen(contents) - proc_offset;
    if (length > remaining) length = remaining;
    memcpy(buffer, contents + proc_offset, length);
    proc_offset += length;
    return (ssize_t)length;
  }
  if (fd != 77) abort();
  if (filter_offset == sizeof(reviewed_filter)) return 0;
  size_t remaining = sizeof(reviewed_filter) - filter_offset;
  if (length > remaining) length = remaining;
  memcpy(buffer, (const unsigned char *)reviewed_filter + filter_offset, length);
  if (filter_fault == 1 && filter_offset == 0) ((unsigned char *)buffer)[0] ^= 1;
  filter_offset += length;
  return (ssize_t)length;
}
static int fake_close(int fd) {
  if (fd != 77 && fd != 78 && fd != 79 && fd != 80 && fd != 81) abort();
  return 0;
}
static uid_t fake_geteuid(void) { return 1000; }
static int fake_clock_gettime(clockid_t clock, struct timespec *now) {
  if (clock != CLOCK_REALTIME) abort();
  now->tv_sec = 1000;
  now->tv_nsec = 0;
  return 0;
}

static void must_reject(void (*fn)(void), const char *stage_name) {
  last_error[0] = 0;
  if (!setjmp(rejected)) { fn(); abort(); }
  char expected[80];
  snprintf(expected, sizeof(expected), "vnc-launcher:%s:", stage_name);
  if (strncmp(last_error, expected, strlen(expected))) abort();
}
static char *bad_mode[] = {"launcher", "shell", "/mock/private", NULL};
static char *bad_secret[] = {"launcher", "credential", "/mock/private", "a-secret!", "1", "2", NULL};
static char *bad_viewer[] = {"launcher", "viewer", "/mock/private", ":1", "3", "1", "2", NULL};
static char *good_viewer[] = {"launcher", "viewer", "/mock/private", ":123", "33", "11", "22", NULL};
static char *good_credential[] = {"launcher", "credential", "/mock/private", "Abc123_-", "11", "22", NULL};
static char *good_credential_borrowed[] = {"launcher", "credential-borrowed", "/mock/private",
  "Abc123_-", "11", "22", "/mock/external/Xauthority", "/mock/external",
  "993", "982", "55", "77", "1000001", NULL};
static char *good_viewer_borrowed[] = {"launcher", "viewer-borrowed", "/mock/private",
  ":2000", "33", "11", "22", "/mock/external/Xauthority", "/mock/external",
  "993", "982", "55", "77", "1000001", NULL};
static char *good_verify[] = {"launcher", "verify", "/mock/private", "33", "11", "22", NULL};
static char *good_internal[] = {"launcher", "--verify-filtered", "/mock/private", "33", "11", "22", "1", "2", "before", NULL};
static void parse_bad_mode(void) { enum mode mode; parse_args(3, bad_mode, &mode); }
static void parse_bad_secret(void) { enum mode mode; parse_args(6, bad_secret, &mode); }
static void parse_bad_viewer(void) { enum mode mode; parse_args(7, bad_viewer, &mode); }
static void parse_credential(void) { enum mode mode; parse_args(6, good_credential, &mode); }
static void parse_viewer_borrowed(void) {
  enum mode mode; parse_args(14, good_viewer_borrowed, &mode);
}
static void parse_credential_borrowed(void) {
  enum mode mode; parse_args(13, good_credential_borrowed, &mode);
}
static void parse_short_credential_borrowed(void) {
  enum mode mode; parse_args(12, good_credential_borrowed, &mode);
}
static void parse_short_viewer_borrowed(void) {
  enum mode mode; parse_args(13, good_viewer_borrowed, &mode);
}
static void borrowed_call(void) { validate_borrowed_authority(); }
static void harden_call(void) { harden(); }
static void filter_call(void) { validate_filter(99); }
static void close_call(void) { close_ambient(); }
static void filtered_call(void) { (void)filtered_entry_dumpable(); }
static void leaked_call(void) { require_closed_fds(extra_fds(), false); }
static void fd9_call(void) { require_closed_fds(0, true); }
static char *const child[] = {"/usr/bin/setpriv", "--no-new-privs", "--seccomp-filter",
  "/mock/private/rfb.seccomp", "--", "/usr/bin/x11vnc", NULL};
static char *const env[] = {"PATH=/usr/bin:/bin", NULL};
static void exec_call(void) { run_setpriv(child, env); }

int main(void) {
  must_reject(parse_bad_mode, "arguments");
  must_reject(parse_bad_secret, "arguments");
  if (strstr(last_error, "a-secret!")) abort();
  must_reject(parse_bad_viewer, "arguments");
  enum mode mode;
  parse_args(7, good_viewer, &mode);
  if (mode != VIEWER || socket_ino != 33 || log_dev != 11 || log_ino != 22) abort();
  parse_args(6, good_credential, &mode);
  if (mode != CREDENTIAL || borrowed || log_dev != 11 || log_ino != 22) abort();
  good_credential[3] = "1234";
  must_reject(parse_credential, "arguments");
  good_credential[3] = "Abc123_-";
  good_credential_borrowed[3] = "1234";
  must_reject(parse_credential_borrowed, "arguments");
  good_credential_borrowed[3] = "Abc123_-";
  must_reject(parse_short_credential_borrowed, "arguments");
  must_reject(parse_short_viewer_borrowed, "arguments");
  good_viewer_borrowed[1] = "viewer-borrowed-extra";
  must_reject(parse_viewer_borrowed, "arguments");
  good_viewer_borrowed[1] = "viewer-borrowed";
  good_viewer_borrowed[3] = ":12345";
  must_reject(parse_viewer_borrowed, "arguments");
  good_viewer_borrowed[3] = ":2000";
  good_viewer_borrowed[7] = "/mock/external/Xauthority-link";
  must_reject(parse_viewer_borrowed, "arguments");
  good_viewer_borrowed[7] = "/mock/external/Xauthority";
  good_viewer_borrowed[8] = "/mock/external-link";
  must_reject(parse_viewer_borrowed, "arguments");
  good_viewer_borrowed[8] = "/mock/external";
  good_viewer_borrowed[9] = "993x";
  must_reject(parse_viewer_borrowed, "arguments");
  good_viewer_borrowed[9] = "993";
  parse_args(13, good_credential_borrowed, &mode);
  if (mode != CREDENTIAL || !borrowed || borrowed_uid != 993 || borrowed_gid != 982 ||
      borrowed_dev != 55 || borrowed_ino != 77 || borrowed_expires != 1000001) abort();
  stage = "contract";
  validate_borrowed_authority();
  for (borrowed_fault = 1; borrowed_fault <= 9; ++borrowed_fault)
    must_reject(borrowed_call, "contract");
  borrowed_fault = 0;
  borrowed_expires = 1000000;
  must_reject(borrowed_call, "contract");
  borrowed_expires = 1000001;
  parse_args(14, good_viewer_borrowed, &mode);
  if (mode != VIEWER || !borrowed || socket_ino != 33 || strcmp(authority,
      "/mock/external/Xauthority")) abort();
  validate_borrowed_authority();
  parse_args(6, good_verify, &mode);
  if (mode != VERIFY || borrowed || socket_ino != 33) abort();
  parse_args(9, good_internal, &mode);
  if (mode != VERIFY_FILTERED || expected_filters != 2 || initial_dumpable != 1 ||
      strcmp(verify_phase, "before")) abort();
  if (exec_calls || close_calls) abort();
  for (harden_fault = 1; harden_fault <= 4; ++harden_fault)
    must_reject(harden_call, "harden");
  harden_fault = 0;
  stage = "contract";
  for (filter_fault = 1; filter_fault <= 3; ++filter_fault)
    must_reject(filter_call, "contract");
  filter_fault = 0;
  validate_filter(99);
  if (extra_fds() != 1) abort();
  leaked_fd = 1;
  if (extra_fds() != 2) abort();
  must_reject(leaked_call, "fd-inventory");
  must_reject(fd9_call, "fd-inventory");
  require_closed_fds(0, false);
  leaked_fd = 0;
  expected_filters = 2;
  for (filtered_fault = 1; filtered_fault <= 4; ++filtered_fault)
    must_reject(filtered_call, filtered_fault <= 2 ? "filtered" :
      filtered_fault == 3 ? "filter-count" : "core-limit-row");
  filtered_fault = 0;
  if (filtered_entry_dumpable() != 0) abort();
  must_reject(close_call, "close-range");
  if (close_calls != 1 || exec_calls) abort();
  must_reject(exec_call, "exec");
  if (exec_calls != 1) abort();
  puts("native launcher pure-mock negative units: PASS");
  return 0;
}
