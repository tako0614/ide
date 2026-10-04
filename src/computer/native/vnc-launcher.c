#define _GNU_SOURCE
#if !defined(__linux__) || !defined(__x86_64__)
#error The private VNC launcher requires Linux x86-64 and close_range.
#endif
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <limits.h>
#include <linux/filter.h>
#include <netinet/in.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>

#if !defined(SYS_close_range)
#error The private VNC launcher requires Linux x86-64 and close_range.
#endif

/* SHA-256 dc159080d3fb3013273eb8badcee46347501de0054da5bab7e72b130fab91c7e.
 * The source-generated file must match every byte, not just its size. */
static const struct sock_filter reviewed_filter[] = {
  {0x20,0,0,4}, {0x15,1,0,0xc000003e}, {0x06,0,0,0x80000000},
  {0x20,0,0,0}, {0x45,0,1,0x40000000}, {0x06,0,0,0x80000000},
  {0x15,0,4,41}, {0x20,0,0,16}, {0x15,0,1,1}, {0x06,0,0,0x7fff0000},
  {0x06,0,0,0x80000000}, {0x15,0,4,53}, {0x20,0,0,16}, {0x15,0,1,1},
  {0x06,0,0,0x7fff0000}, {0x06,0,0,0x80000000},
  {0x15,0,1,49}, {0x06,0,0,0x80000000},
  {0x15,0,1,50}, {0x06,0,0,0x80000000},
  {0x15,0,1,43}, {0x06,0,0,0x80000000},
  {0x15,0,1,288}, {0x06,0,0,0x80000000},
  {0x15,0,1,425}, {0x06,0,0,0x80000000},
  {0x15,0,1,426}, {0x06,0,0,0x80000000},
  {0x15,0,1,427}, {0x06,0,0,0x80000000},
  {0x15,0,1,101}, {0x06,0,0,0x80000000},
  {0x15,0,1,310}, {0x06,0,0,0x80000000},
  {0x15,0,1,311}, {0x06,0,0,0x80000000},
  {0x15,0,1,438}, {0x06,0,0,0x80000000},
  {0x06,0,0,0x7fff0000}
};
_Static_assert(sizeof(reviewed_filter) == 312, "reviewed filter length changed");

enum mode { CREDENTIAL, VIEWER, VERIFY, VERIFY_FILTERED };
static const char *stage = "arguments";
static char root[PATH_MAX], authority[PATH_MAX], password[PATH_MAX], filter[PATH_MAX];
static char borrowed_authority[PATH_MAX], borrowed_dir[PATH_MAX];
static char self_exe[PATH_MAX];
static uint64_t socket_ino, log_dev, log_ino;
static uint64_t borrowed_uid, borrowed_gid, borrowed_dev, borrowed_ino, borrowed_expires;
static bool borrowed;
static int initial_dumpable;
static uint64_t expected_filters, baseline_filters;
static const char *verify_phase;
static char raw_core_limit[256];

static void fail(void) __attribute__((noreturn));
static void fail(void) {
  int saved = errno;
  /* Only fixed stage identifiers and numeric errno; never argv or environment. */
  (void)dprintf(STDERR_FILENO, "vnc-launcher:%s:%d\n", stage, saved);
  _exit(126);
}
static void reject(void) __attribute__((noreturn));
static void reject(void) { errno = EINVAL; fail(); }

static bool decimal(const char *s, uint64_t *value) {
  if (!s || !*s) return false;
  uint64_t n = 0;
  for (const unsigned char *p = (const unsigned char *)s; *p; ++p) {
    if (*p < '0' || *p > '9' || n > (UINT64_MAX - (*p - '0')) / 10) return false;
    n = n * 10 + (*p - '0');
  }
  *value = n;
  return true;
}
static bool secret_ok(const char *s) {
  if (!s || strlen(s) != 8) return false;
  for (size_t i = 0; i < 8; ++i) {
    char c = s[i];
    if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
          (c >= '0' && c <= '9') || c == '_' || c == '-')) return false;
  }
  return true;
}
static bool display_ok(const char *s) {
  if (!s || s[0] != ':') return false;
  size_t len = strlen(s);
  if (len < 3 || len > 5) return false;
  for (size_t i = 1; i < len; ++i) if (s[i] < '0' || s[i] > '9') return false;
  return true;
}
static void make_path(char *out, size_t cap, const char *name) {
  int n = snprintf(out, cap, "%s/%s", root, name);
  if (n < 0 || (size_t)n >= cap) reject();
}
static void parse_args(int argc, char **argv, enum mode *mode) {
  if (argc < 2) reject();
  borrowed = !strcmp(argv[1], "credential-borrowed") || !strcmp(argv[1], "viewer-borrowed");
  if (!strcmp(argv[1], "credential") || !strcmp(argv[1], "credential-borrowed")) {
    if (argc != (borrowed ? 13 : 6) || !secret_ok(argv[3])) reject();
    *mode = CREDENTIAL;
  } else if (!strcmp(argv[1], "viewer") || !strcmp(argv[1], "viewer-borrowed")) {
    if (argc != (borrowed ? 14 : 7) || !display_ok(argv[3])) reject();
    *mode = VIEWER;
  } else if (!strcmp(argv[1], "verify")) {
    if (argc != 6) reject();
    *mode = VERIFY;
  } else if (!strcmp(argv[1], "--verify-filtered")) {
    if (argc != 9 || (strcmp(argv[8], "before") && strcmp(argv[8], "after"))) reject();
    *mode = VERIFY_FILTERED;
    verify_phase = argv[8];
  } else reject();
  const char *given_root = argv[2];
  if (!given_root || given_root[0] != '/' || strlen(given_root) >= sizeof(root) - 32 ||
      !strcmp(given_root, "/") || !realpath(given_root, root) || strcmp(given_root, root)) reject();
  make_path(authority, sizeof(authority), "Xauthority");
  make_path(password, sizeof(password), "rfb.passwd");
  make_path(filter, sizeof(filter), "rfb.seccomp");
  int index = *mode == CREDENTIAL ? 4 : *mode == VIEWER ? 4 : 3;
  if (*mode != CREDENTIAL && (!decimal(argv[index], &socket_ino) || !socket_ino)) reject();
  if (!decimal(argv[index + (*mode == CREDENTIAL ? 0 : 1)], &log_dev) ||
      !decimal(argv[index + (*mode == CREDENTIAL ? 1 : 2)], &log_ino) || !log_ino) reject();
  if (borrowed) {
    int path_index = *mode == CREDENTIAL ? 6 : 7;
    const char *path = argv[path_index], *dir = argv[path_index + 1];
    if (!path || !dir || path[0] != '/' || dir[0] != '/' ||
        strlen(path) >= sizeof(borrowed_authority) ||
        strlen(dir) >= sizeof(borrowed_dir) || !strcmp(dir, "/") ||
        !realpath(dir, borrowed_dir) || strcmp(dir, borrowed_dir) ||
        !realpath(path, borrowed_authority) || strcmp(path, borrowed_authority)) reject();
    size_t dir_len = strlen(borrowed_dir);
    if (strncmp(borrowed_authority, borrowed_dir, dir_len) ||
        borrowed_authority[dir_len] != '/' || !borrowed_authority[dir_len + 1] ||
        strchr(borrowed_authority + dir_len + 1, '/')) reject();
    if (!decimal(argv[path_index + 2], &borrowed_uid) ||
        !decimal(argv[path_index + 3], &borrowed_gid) ||
        !decimal(argv[path_index + 4], &borrowed_dev) ||
        !decimal(argv[path_index + 5], &borrowed_ino) || !borrowed_ino ||
        !decimal(argv[path_index + 6], &borrowed_expires)) reject();
    if (*mode == VIEWER) memcpy(authority, borrowed_authority, strlen(borrowed_authority) + 1);
  }
  if (*mode == VERIFY_FILTERED) {
    uint64_t input;
    if (!decimal(argv[6], &input) || input > 1 ||
        !decimal(argv[7], &expected_filters) || !expected_filters) reject();
    initial_dumpable = (int)input;
  }
}

static void validate_borrowed_authority(void) {
  struct timespec now;
  if (clock_gettime(CLOCK_REALTIME, &now) || now.tv_sec < 0 ||
      (uint64_t)now.tv_sec > (UINT64_MAX - 999) / 1000 ||
      borrowed_expires <= (uint64_t)now.tv_sec * 1000 + (uint64_t)now.tv_nsec / 1000000) reject();
  int dirfd = open(borrowed_dir, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (dirfd < 0) fail();
  struct stat dir, file;
  bool valid = fstat(dirfd, &dir) == 0 && S_ISDIR(dir.st_mode) &&
    (uint64_t)dir.st_uid == borrowed_uid && (uint64_t)dir.st_gid == borrowed_gid &&
    (dir.st_mode & 07777) == 0700;
  if (!valid) { if (close(dirfd)) fail(); reject(); }
  const char *base = borrowed_authority + strlen(borrowed_dir) + 1;
  int fd = openat(dirfd, base, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) { if (close(dirfd)) fail(); fail(); }
  valid = fstat(fd, &file) == 0 && S_ISREG(file.st_mode) &&
    (file.st_mode & 07777) == 0600 && file.st_nlink == 1 &&
    (uint64_t)file.st_uid == borrowed_uid && (uint64_t)file.st_gid == borrowed_gid &&
    (uint64_t)file.st_dev == borrowed_dev && (uint64_t)file.st_ino == borrowed_ino;
  int file_close = close(fd), dir_close = close(dirfd);
  if (file_close || dir_close) fail();
  if (!valid) reject();
}
static void file_check(int dirfd, const char *name, bool must_exist) {
  struct stat st;
  int fd = openat(dirfd, name, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0 && !must_exist && errno == ENOENT) return;
  if (fd < 0) fail();
  bool valid = fstat(fd, &st) == 0 && S_ISREG(st.st_mode) && st.st_uid == geteuid() &&
    (st.st_mode & 07777) == 0600 && st.st_nlink == 1;
  if (close(fd)) fail();
  if (must_exist ? !valid : true) reject();
}
static void validate_filter(int dirfd) {
  int fd = openat(dirfd, "rfb.seccomp", O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) fail();
  struct stat st;
  unsigned char data[sizeof(reviewed_filter)];
  bool valid = fstat(fd, &st) == 0 && S_ISREG(st.st_mode) && st.st_uid == geteuid() &&
    (st.st_mode & 07777) == 0600 && st.st_nlink == 1 && st.st_size == (off_t)sizeof(data);
  size_t got = 0;
  while (valid && got < sizeof(data)) {
    ssize_t n = read(fd, data + got, sizeof(data) - got);
    if (n <= 0) { valid = false; break; }
    got += (size_t)n;
  }
  unsigned char extra;
  if (valid && (read(fd, &extra, 1) != 0 || memcmp(data, reviewed_filter, sizeof(data)))) valid = false;
  if (close(fd)) fail();
  if (!valid) reject();
}
static void validate_stdio(enum mode mode, int dirfd) {
  struct stat a, b, log;
  if (fstat(0, &a) || fstat(1, &b) || fstat(2, &log)) fail();
  if (mode == CREDENTIAL) {
    struct stat null_stat;
    if (stat("/dev/null", &null_stat) || !S_ISCHR(a.st_mode) || !S_ISCHR(b.st_mode) ||
        a.st_dev != null_stat.st_dev || a.st_ino != null_stat.st_ino ||
        b.st_dev != null_stat.st_dev || b.st_ino != null_stat.st_ino) reject();
  } else {
    int domain0 = 0, domain1 = 0, type0 = 0, type1 = 0;
    socklen_t size = sizeof(int), peer_size = sizeof(struct sockaddr_storage);
    struct sockaddr_storage peer;
    if (!S_ISSOCK(a.st_mode) || !S_ISSOCK(b.st_mode) ||
        a.st_ino != socket_ino || b.st_ino != socket_ino || a.st_dev != b.st_dev ||
        getsockopt(0, SOL_SOCKET, SO_DOMAIN, &domain0, &size) || size != sizeof(int) ||
        getsockopt(1, SOL_SOCKET, SO_DOMAIN, &domain1, &size) || size != sizeof(int) ||
        getsockopt(0, SOL_SOCKET, SO_TYPE, &type0, &size) || size != sizeof(int) ||
        getsockopt(1, SOL_SOCKET, SO_TYPE, &type1, &size) || size != sizeof(int) ||
        getpeername(0, (struct sockaddr *)&peer, &peer_size) || peer.ss_family != AF_UNIX ||
        domain0 != AF_UNIX || domain1 != AF_UNIX ||
        type0 != SOCK_STREAM || type1 != SOCK_STREAM) reject();
  }
  if (!S_ISREG(log.st_mode) || log.st_uid != geteuid() ||
      (log.st_mode & 07777) != 0600 || log.st_nlink != 1 ||
      (uint64_t)log.st_dev != log_dev || (uint64_t)log.st_ino != log_ino) reject();
  char link[PATH_MAX], expected[PATH_MAX];
  ssize_t n = readlink("/proc/self/fd/2", link, sizeof(link) - 1);
  if (n < 0 || (size_t)n >= sizeof(link) - 1) reject();
  link[n] = 0;
  size_t prefix = strlen(root);
  if (strncmp(link, root, prefix) || link[prefix] != '/' ||
      strncmp(link + prefix + 1, "stderr-", 7)) reject();
  const char *base = link + prefix + 1;
  if (strlen(base) != 43 || strcmp(base + 39, ".log")) reject();
  for (size_t i = 7; i < 39; ++i)
    if (!((base[i] >= '0' && base[i] <= '9') || (base[i] >= 'a' && base[i] <= 'f'))) reject();
  make_path(expected, sizeof(expected), base);
  if (strcmp(link, expected)) reject();
  int fd = openat(dirfd, base, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  struct stat named;
  if (fd < 0 || fstat(fd, &named) || close(fd) ||
      named.st_dev != log.st_dev || named.st_ino != log.st_ino) reject();
}
static void validate_contract(enum mode mode) {
  stage = "contract";
  struct stat st;
  int dirfd = open(root, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (dirfd < 0 || fstat(dirfd, &st)) fail();
  if (!S_ISDIR(st.st_mode) || st.st_uid != geteuid() || (st.st_mode & 07777) != 0700) reject();
  validate_stdio(mode, dirfd);
  validate_filter(dirfd);
  if (borrowed) validate_borrowed_authority();
  else file_check(dirfd, "Xauthority", true);
  file_check(dirfd, "rfb.passwd", mode != CREDENTIAL);
  if (close(dirfd)) fail();
}

static void harden(void) {
  stage = "harden";
  const struct rlimit core = {0, 0}, file = {65536, 65536};
  struct rlimit actual;
  if (setrlimit(RLIMIT_CORE, &core) || prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) ||
      setrlimit(RLIMIT_FSIZE, &file) || prctl(PR_GET_DUMPABLE, 0, 0, 0, 0) != 0 ||
      getrlimit(RLIMIT_CORE, &actual) || actual.rlim_cur || actual.rlim_max ||
      getrlimit(RLIMIT_FSIZE, &actual) || actual.rlim_cur != 65536 || actual.rlim_max != 65536) fail();
}
static uint64_t filter_count(void) {
  stage = "filter-count";
  int fd = open("/proc/self/status", O_RDONLY | O_CLOEXEC);
  if (fd < 0) fail();
  char data[8192];
  size_t used = 0;
  while (used < sizeof(data) - 1) {
    ssize_t n = read(fd, data + used, sizeof(data) - 1 - used);
    if (n < 0) fail();
    if (n == 0) break;
    used += (size_t)n;
  }
  if (close(fd) || used == sizeof(data) - 1) fail();
  data[used] = 0;
  const char *needle = "Seccomp_filters:";
  char *p = strstr(data, needle);
  if (!p || (p != data && p[-1] != '\n')) reject();
  p += strlen(needle);
  while (*p == ' ' || *p == '\t') ++p;
  char *end = strchr(p, '\n');
  if (!end) reject();
  *end = 0;
  uint64_t count;
  if (!decimal(p, &count)) reject();
  return count;
}
static void core_limit_row(void) {
  stage = "core-limit-row";
  int fd = open("/proc/self/limits", O_RDONLY | O_CLOEXEC);
  if (fd < 0) fail();
  char data[8192];
  size_t used = 0;
  while (used < sizeof(data) - 1) {
    ssize_t n = read(fd, data + used, sizeof(data) - 1 - used);
    if (n < 0) fail();
    if (n == 0) break;
    used += (size_t)n;
  }
  if (close(fd) || used == sizeof(data) - 1) fail();
  data[used] = 0;
  const char *needle = "Max core file size";
  char *p = strstr(data, needle);
  if (!p || (p != data && p[-1] != '\n')) reject();
  char *end = strchr(p, '\n');
  if (!end || (size_t)(end - p) >= sizeof(raw_core_limit)) reject();
  for (char *at = p; at < end; ++at)
    if (!((*at >= ' ' && *at <= '~') && *at != '"' && *at != '\\')) reject();
  memcpy(raw_core_limit, p, (size_t)(end - p));
  raw_core_limit[end - p] = 0;
}
static int filtered_entry_dumpable(void) {
  stage = "filtered";
  if (prctl(PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0) != 1 ||
      prctl(PR_GET_SECCOMP, 0, 0, 0, 0) != 2 ||
      filter_count() != expected_filters) reject();
  core_limit_row();
  struct rlimit lim;
  int entry_dumpable = prctl(PR_GET_DUMPABLE, 0, 0, 0, 0);
  if (entry_dumpable < 0 || entry_dumpable > 1 ||
      getrlimit(RLIMIT_CORE, &lim) || lim.rlim_cur || lim.rlim_max ||
      getrlimit(RLIMIT_FSIZE, &lim) || lim.rlim_cur != 65536 || lim.rlim_max != 65536) reject();
  return entry_dumpable;
}
static uint64_t extra_fds(void) {
  stage = "fd-inventory";
  DIR *dir = opendir("/proc/self/fd");
  if (!dir) fail();
  int own = dirfd(dir);
  struct dirent *entry;
  uint64_t count = 0;
  errno = 0;
  while ((entry = readdir(dir))) {
    if (entry->d_name[0] == '.') continue;
    uint64_t fd;
    if (!decimal(entry->d_name, &fd)) reject();
    if (fd >= 3 && fd != (uint64_t)own) ++count;
    errno = 0;
  }
  if (errno) fail();
  if (closedir(dir)) fail();
  return count;
}
static void require_closed_fds(uint64_t extras, bool fd9_open) {
  stage = "fd-inventory";
  if (fd9_open || extras) reject();
}
static uint64_t start_ticks(void) {
  stage = "identity";
  int fd = open("/proc/self/stat", O_RDONLY | O_CLOEXEC);
  if (fd < 0) fail();
  char data[8192];
  ssize_t n = read(fd, data, sizeof(data) - 1);
  if (close(fd) || n <= 0 || n >= (ssize_t)sizeof(data) - 1) fail();
  data[n] = 0;
  char *p = strrchr(data, ')');
  if (!p || p[1] != ' ') reject();
  p += 2;
  for (int field = 3; field < 22; ++field) {
    p = strchr(p, ' ');
    if (!p) reject();
    ++p;
  }
  char *end = strchr(p, ' ');
  if (!end) reject();
  *end = 0;
  uint64_t result;
  if (!decimal(p, &result)) reject();
  return result;
}
static void marker(const char *kind, int entry_dumpable, bool require_closed) {
  uint64_t ticks = start_ticks();
  stage = "record";
  if (!raw_core_limit[0]) core_limit_row();
  struct rlimit core, file;
  int dump = prctl(PR_GET_DUMPABLE, 0, 0, 0, 0);
  int nnp = prctl(PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0);
  int seccomp = prctl(PR_GET_SECCOMP, 0, 0, 0, 0);
  if (dump < 0 || nnp < 0 || seccomp < 0 ||
      getrlimit(RLIMIT_CORE, &core) || getrlimit(RLIMIT_FSIZE, &file)) fail();
  uint64_t filters = filter_count();
  uint64_t extras = extra_fds();
  bool fd9_open = fcntl(9, F_GETFD) != -1;
  if (require_closed) require_closed_fds(extras, fd9_open);
  if (!require_closed && !fd9_open) reject();
  stage = "record";
  if (dprintf(1, "{\"kind\":\"%s\",\"pid\":%ld,\"pgrp\":%ld,"
      "\"startTicks\":\"%" PRIu64 "\",\"inputDumpable\":%d,"
      "\"entryDumpable\":%d,\"dumpable\":%d,"
      "\"coreSoft\":%" PRIu64 ",\"coreHard\":%" PRIu64 ","
      "\"rawCoreLimit\":\"%s\","
      "\"fileSizeSoft\":%" PRIu64 ",\"fileSizeHard\":%" PRIu64 ","
      "\"fd9Open\":%s,\"extraFdCount\":%" PRIu64 ","
      "\"noNewPrivs\":%d,\"seccomp\":%d,\"seccompFilters\":%" PRIu64 ","
      "\"socketInode\":\"%" PRIu64 "\",\"stderrDev\":\"%" PRIu64 "\","
      "\"stderrInode\":\"%" PRIu64 "\",\"stdioUnix\":true,\"stderrPrivate\":true}\n",
      kind, (long)getpid(), (long)getpgrp(), ticks, initial_dumpable,
      entry_dumpable, dump, (uint64_t)core.rlim_cur, (uint64_t)core.rlim_max,
      raw_core_limit,
      (uint64_t)file.rlim_cur, (uint64_t)file.rlim_max,
      fd9_open ? "true" : "false", extras, nnp, seccomp, filters,
      socket_ino, log_dev, log_ino) < 0) fail();
}
static void close_ambient(void) {
  stage = "close-range";
  if (syscall(SYS_close_range, 3U, ~0U, 0U)) fail();
}
static void run_setpriv(char *const child_argv[], char *const clean_env[])
  __attribute__((noreturn));
static void run_setpriv(char *const child_argv[], char *const clean_env[]) {
  stage = "exec";
  execve("/usr/bin/setpriv", child_argv, clean_env);
  fail();
}

int main(int argc, char **argv) {
  enum mode mode;
  parse_args(argc, argv, &mode);
  if (mode == VERIFY_FILTERED) {
    /* A direct unfiltered invocation cannot enter the diagnostic phase. */
    int entry_dumpable = filtered_entry_dumpable();
    validate_contract(mode);
    if (prctl(PR_SET_DUMPABLE, 0, 0, 0, 0)) fail();
    marker(!strcmp(verify_phase, "before") ? "verify-before" : "verify-after",
      entry_dumpable, true);
    if (!strcmp(verify_phase, "before")) {
      ssize_t n = readlink("/proc/self/exe", self_exe, sizeof(self_exe) - 1);
      if (n <= 0 || (size_t)n >= sizeof(self_exe) - 1) fail();
      self_exe[n] = 0;
      char canonical[PATH_MAX];
      if (!realpath(self_exe, canonical) || strcmp(canonical, self_exe)) reject();
      char *const env[] = {"PATH=/usr/bin:/bin", "LANG=C", "LC_ALL=C", NULL};
      char *const next[] = {self_exe, "--verify-filtered", root, argv[3], argv[4],
        argv[5], argv[6], argv[7], "after", NULL};
      stage = "self-exec";
      execve(self_exe, next, env);
      fail();
    }
    return 0;
  }
  validate_contract(mode);
  baseline_filters = filter_count();
  initial_dumpable = prctl(PR_GET_DUMPABLE, 0, 0, 0, 0);
  if (initial_dumpable < 0 || initial_dumpable > 1) fail();
  harden();
  if (mode == VERIFY) {
    if (fcntl(9, F_GETFD) < 0) reject();
    marker("launcher-before", initial_dumpable, false);
    ssize_t n = readlink("/proc/self/exe", self_exe, sizeof(self_exe) - 1);
    if (n <= 0 || (size_t)n >= sizeof(self_exe) - 1) fail();
    self_exe[n] = 0;
    char canonical[PATH_MAX];
    if (!realpath(self_exe, canonical) || strcmp(canonical, self_exe)) reject();
  }
  close_ambient();
  if (mode == VERIFY) {
    marker("launcher-closed", initial_dumpable, true);
  }
  char input_dump[2] = {(char)('0' + initial_dumpable), 0};
  char filter_count_arg[32];
  if (baseline_filters == UINT64_MAX) reject();
  if (snprintf(filter_count_arg, sizeof(filter_count_arg), "%" PRIu64,
      baseline_filters + 1) <= 0) reject();
  char *const clean_env[] = {"PATH=/usr/bin:/bin", "LANG=C", "LC_ALL=C", NULL};
  char *const credential_argv[] = {"/usr/bin/setpriv", "--no-new-privs", "--seccomp-filter", filter,
    "--", "/usr/bin/x11vnc", "-norc", "-storepasswd", argv[3], password, NULL};
  char *const viewer_argv[] = {"/usr/bin/setpriv", "--no-new-privs", "--seccomp-filter", filter,
    "--", "/usr/bin/x11vnc", "-norc", "-display", argv[3], "-auth", authority,
    "-inetd", "-q", "-no6", "-noipv6", "-rfbauth", password,
    "-nosel", "-noclipboard", "-nosetclipboard", "-noremote", "-safer", "-nocmds", NULL};
  char *const verify_argv[] = {"/usr/bin/setpriv", "--no-new-privs", "--seccomp-filter", filter,
    "--", self_exe, "--verify-filtered", root, argv[3], argv[4], argv[5],
    input_dump, filter_count_arg, "before", NULL};
  run_setpriv(mode == CREDENTIAL ? credential_argv :
    mode == VIEWER ? viewer_argv : verify_argv, clean_env);
}
