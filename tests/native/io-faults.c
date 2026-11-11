// Linux-only external native-test instrumentation. Interpose writes only to
// explicitly generated fixture staging, never arbitrary/user paths. No app hook.
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/syscall.h>
#include <unistd.h>

ssize_t write(int fd, const void *data, size_t length) {
    const char *root = getenv("QPANES_TEST_IO_ROOT");
    char link[64], path[4096], marker[4096];
    if (root && *root && length && strlen(root) < 3000) {
        snprintf(link, sizeof(link), "/proc/self/fd/%d", fd);
        ssize_t count = syscall(SYS_readlink, link, path, sizeof(path)-1);
        if (count > 0) {
            path[count] = '\0';
            size_t root_len = strlen(root);
            if (!strncmp(path, root, root_len) && path[root_len] == '/' &&
                strstr(path + root_len, "/.qpanes-copy-") && strstr(path + root_len, "/payload")) {
                snprintf(marker, sizeof(marker), "%s/slow-writes", root);
                if (!access(marker, F_OK)) usleep(6000);
                snprintf(marker, sizeof(marker), "%s/blocked-writes", root);
                if (!access(marker, F_OK)) {
                    char entered[4096];
                    snprintf(entered, sizeof(entered), "%s/write-blocked", root);
                    int signal = syscall(SYS_openat, AT_FDCWD, entered,
                        O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
                    if (signal >= 0) {
                        syscall(SYS_write, signal, "1", 1);
                        syscall(SYS_close, signal);
                    }
                }
                // Bounded fault injection, even if a test is interrupted.
                for (int attempt = 0; attempt < 800 && !access(marker, F_OK); attempt++) usleep(10000);
                snprintf(marker, sizeof(marker), "%s/fail-writes", root);
                if (!access(marker, F_OK)) { errno = ENOSPC; return -1; }
            }
        }
    }
    return syscall(SYS_write, fd, data, length);
}
