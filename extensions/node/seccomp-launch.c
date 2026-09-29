/*
 * seccomp-launch: install the node worker's syscall policy, then exec node.
 *
 * Why this exists: the sandboxed node worker needs the same syscall policy as
 * the python worker (socket/socketpair/ptrace/... blocked with EPERM), but
 * node has no stdlib FFI to load libseccomp, and `bwrap --seccomp` fails on
 * this machine (prctl(PR_SET_SECCOMP) reports EINVAL even for a known-good
 * libseccomp-exported BPF program, while seccomp installs fine from inside
 * the bwrap user namespace). This launcher runs inside the sandbox as the
 * bwrap argv tail, installs the policy, and execvp's the interpreter, so node
 * starts with the filter already active. rlimits set by the outer prlimit
 * wrapper survive the exec; spawned subprocesses inherit the filter.
 *
 * libseccomp's API is declared by hand (no <seccomp.h>) so compilation needs
 * only the runtime shared object, exactly like the python tool: no seccomp
 * development package. sandbox.ts compiles this with `cc -O2 -o
 * seccomp-launch seccomp-launch.c /path/to/libseccomp.so.2` (passing the
 * shared object directly records its soname) and caches the binary per arch
 * + source hash. Failures are fatal (the parent treats them as worker
 * death): print a diagnostic prefixed with "seccomp-launch:" and exit
 * nonzero.
 *
 * Build: cc -O2 -o seccomp-launch seccomp-launch.c /usr/lib/x86_64-linux-gnu/libseccomp.so.2
 */
#define _GNU_SOURCE
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/prctl.h>

/* Hand-declared libseccomp ABI (stable since 2.x). */
typedef void *scmp_filter_ctx;
#define SCMP_ACT_ALLOW 0x7fff0000U
#define SCMP_ACT_ERRNO(x) (0x00050000U | ((x) & 0xffffU))
extern scmp_filter_ctx seccomp_init(uint32_t def_action);
extern int seccomp_rule_add(scmp_filter_ctx ctx, uint32_t action, int syscall, unsigned int arg_cnt, ...);
extern int seccomp_load(scmp_filter_ctx ctx);
extern int seccomp_syscall_resolve_name(const char *name);
extern void seccomp_release(scmp_filter_ctx ctx);

/* Same policy as extensions/python/worker.py: socket/socketpair are required
 * restrictions; the rest are hardening against introspection and kernel
 * tampering. Default is allow; each blocked syscall gets EPERM. */
static const char *const BLOCKED[] = {
	"socket",
	"socketpair",
	"ptrace",
	"bpf",
	"userfaultfd",
	"perf_event_open",
	"process_vm_readv",
	"process_vm_writev",
	"kexec_load",
	"kexec_file_load",
	"open_by_handle_at",
	"name_to_handle_at",
};

int main(int argc, char **argv) {
	if (argc < 2) {
		fprintf(stderr, "seccomp-launch: usage: seccomp-launch <interpreter> [args...]\n");
		return 2;
	}
	scmp_filter_ctx ctx = seccomp_init(SCMP_ACT_ALLOW);
	if (ctx == NULL) {
		fprintf(stderr, "seccomp-launch: seccomp_init failed\n");
		return 1;
	}
	for (size_t i = 0; i < sizeof(BLOCKED) / sizeof(BLOCKED[0]); i++) {
		int num = seccomp_syscall_resolve_name(BLOCKED[i]);
		if (num < 0) {
			fprintf(stderr, "seccomp-launch: libseccomp does not know syscall %s\n", BLOCKED[i]);
			return 1;
		}
		if (seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EPERM), num, 0) != 0) {
			fprintf(stderr, "seccomp-launch: seccomp_rule_add failed for %s\n", BLOCKED[i]);
			return 1;
		}
	}
	/* Not strictly required inside bubblewrap (it sets no_new_privs), but
	 * harmless and required if the launcher is ever run outside it. */
	if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) {
		fprintf(stderr, "seccomp-launch: prctl(PR_SET_NO_NEW_PRIVS): %s\n", strerror(errno));
		return 1;
	}
	if (seccomp_load(ctx) != 0) {
		fprintf(stderr, "seccomp-launch: seccomp_load failed (missing kernel seccomp support?)\n");
		return 1;
	}
	seccomp_release(ctx);
	execvp(argv[1], &argv[1]);
	fprintf(stderr, "seccomp-launch: execvp %s: %s\n", argv[1], strerror(errno));
	return 1;
}
