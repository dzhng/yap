#include <sys/file.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <pwd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <limits.h>

#ifndef YAP_SYSTEM_APPLICATIONS
#define YAP_SYSTEM_APPLICATIONS "/Applications"
#endif

struct refusal { const char *code; int retryable; int retryAfterMs; };
static const struct refusal refusals[] = YAP_REFUSAL_LEDGER;
static int fail(const char *code, const char *message, int status) {
    for (size_t i = 0; i < sizeof(refusals) / sizeof(refusals[0]); ++i) {
        if (strcmp(code, refusals[i].code)) continue;
        printf("{\"id\":\"launcher\",\"ok\":false,\"error\":{\"code\":\"%s\",\"message\":\"%s\",\"retryable\":%s", code, message, refusals[i].retryable ? "true" : "false");
        if (refusals[i].retryAfterMs > 0) printf(",\"retryAfterMs\":%d", refusals[i].retryAfterMs);
        puts("}}");
        return status;
    }
    abort(); // Every emitted code is admitted by the build's ledger projection.
}
static int directory(const char *path) {
    if (mkdir(path, 0700) != 0 && errno != EEXIST) return -1;
    struct stat info;
    if (lstat(path, &info) != 0 || !S_ISDIR(info.st_mode) || info.st_uid != getuid()) return -1;
    return 0;
}
int main(int argc, char **argv) {
    struct passwd *account = getpwuid(getuid());
    if (!account || !account->pw_dir || !*account->pw_dir)
        return fail("SERVICE_UNAVAILABLE", "Cannot resolve account home", 74);
    const char *lockHome = account->pw_dir;
    const char *appHome = getenv("HOME");
    if (!appHome || !*appHome) appHome = lockHome;
    char path[PATH_MAX], app[PATH_MAX], node[PATH_MAX], cli[PATH_MAX];
    const char *parts[] = {"Library", "Library/Caches", "Library/Caches/com.dzhng.yap"};
    for (size_t i = 0; i < sizeof(parts) / sizeof(parts[0]); ++i) {
        if (snprintf(path, sizeof(path), "%s/%s", lockHome, parts[i]) >= (int)sizeof(path) || directory(path) != 0)
            return fail("SERVICE_UNAVAILABLE", "Cannot prepare installation lock directory", 74);
    }
    if (snprintf(path, sizeof(path), "%s/Library/Caches/com.dzhng.yap/launch.lock", lockHome) >= (int)sizeof(path))
        return fail("SERVICE_UNAVAILABLE", "Account home path is too long", 74);
    // Deliberately inherited: exclusion owns the complete CLI/MCP or media tool lifetime.
    int fd = open(path, O_CREAT | O_RDWR | O_NOFOLLOW, 0600);
    struct stat info, named;
    if (fd < 0 || fstat(fd, &info) != 0 || lstat(path, &named) != 0 || !S_ISREG(info.st_mode) || info.st_uid != getuid() || info.st_nlink != 1 || (info.st_mode & 077) != 0 || info.st_dev != named.st_dev || info.st_ino != named.st_ino)
        return fail("SERVICE_UNAVAILABLE", "Cannot open private installation lock", 74);
    if (flock(fd, LOCK_SH | LOCK_NB) != 0) {
        if (errno == EWOULDBLOCK) return fail("UPDATING", "Installation is being replaced; retry after the update", 75);
        return fail("SERVICE_UNAVAILABLE", "Cannot acquire installation lock", 74);
    }
    // A long-lived session (yap mcp) holds the lock only while it works, so it is told which
    // descriptor carries this lifetime's lock and where to take it again.
    char descriptor[32];
    snprintf(descriptor, sizeof(descriptor), "%d", fd);
    setenv("YAP_LAUNCH_LOCK_FD", descriptor, 1);
    setenv("YAP_LAUNCH_LOCK", path, 1);
    // No access to the replaceable bundle occurs before shared exclusion is held.
    // Lookup order: $YAP_APP, then the home Applications copy if present, then the system one.
    const char *override = getenv("YAP_APP");
    if (override && *override) {
        if (snprintf(app, sizeof(app), "%s", override) >= (int)sizeof(app))
            return fail("SERVICE_UNAVAILABLE", "App path is too long", 74);
    } else {
        if (snprintf(app, sizeof(app), "%s/Applications/Yap.app", appHome) >= (int)sizeof(app))
            return fail("SERVICE_UNAVAILABLE", "App path is too long", 74);
        if ((stat(app, &named) != 0 || !S_ISDIR(named.st_mode)) &&
            snprintf(app, sizeof(app), "%s/Yap.app", YAP_SYSTEM_APPLICATIONS) >= (int)sizeof(app))
            return fail("SERVICE_UNAVAILABLE", "App path is too long", 74);
    }
    setenv("YAP_APP", app, 1);
    if (argc > 1 && (!strcmp(argv[1], "ffmpeg") || !strcmp(argv[1], "ffprobe"))) {
        if (snprintf(path, sizeof(path), "%s/Contents/Resources/ffmpeg/bin/%s", app, argv[1]) >= (int)sizeof(path))
            return fail("SERVICE_UNAVAILABLE", "App path is too long", 74);
        execv(path, argv + 1);
        return fail("SERVICE_UNAVAILABLE", "Bundled media tool could not start; verify the installed app", 74);
    }
    if (snprintf(node, sizeof(node), "%s/Contents/Resources/node/bin/node", app) >= (int)sizeof(node) ||
        snprintf(cli, sizeof(cli), "%s/Contents/Resources/cli/main.mjs", app) >= (int)sizeof(cli))
        return fail("SERVICE_UNAVAILABLE", "App path is too long", 74);
    char **arguments = calloc((size_t)argc + 2, sizeof(char *));
    if (!arguments) return fail("SERVICE_UNAVAILABLE", "Cannot allocate launcher arguments", 74);
    arguments[0] = node; arguments[1] = cli;
    for (int i = 1; i < argc; ++i) arguments[i + 1] = argv[i];
    execv(node, arguments);
    return fail("SERVICE_UNAVAILABLE", "Bundled Node could not start; verify the installed app", 74);
}
