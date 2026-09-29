/* keepalive.c — uinput idle-lock keepalive for the headless lab VM.
 *
 * The AI-Arch lab VM (TCG-only host) locks the desktop after ~5 minutes of
 * input-based idle; a locked screen renders black and blocks visual
 * verification. This program creates a virtual uinput keyboard and taps
 * KEY_LEFTALT every 30 s, which resets the idle timer without disturbing
 * the session. (KEY_RESERVED does not count as input; real keys do.)
 *
 * Build:
 *   gcc -O2 -o keepalive keepalive.c
 * Run (desktop user must be able to open /dev/uinput; on the lab VM:
 * archdev works, or wrap in a transient unit):
 *   sudo systemd-run --unit=aiarch-keepalive /usr/local/bin/keepalive
 * Stop:
 *   sudo systemctl stop aiarch-keepalive
 *
 * Requires the kernel uinput module (linux-uinput on Arch). Uses the
 * modern uinput API: UI_DEV_SETUP + UI_DEV_CREATE on the first fd
 * (second-fd create returns EINVAL).
 */
#define _GNU_SOURCE
#include <linux/uinput.h>
#include <linux/input.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/ioctl.h>
#include <stdio.h>
#include <stdlib.h>
#include <signal.h>
#include <string.h>

static volatile int running = 1;
static void sigh(int s){ (void)s; running = 0; }

static void ev(int fd, int type, int code, int val){
    struct input_event e; memset(&e,0,sizeof(e));
    e.type=type; e.code=code; e.value=val;
    write(fd,&e,sizeof(e));
}

int main(void){
    signal(SIGTERM,sigh); signal(SIGINT,sigh);
    int fd = open("/dev/uinput", O_RDWR|O_NONBLOCK);
    if (fd<0){ perror("open uinput"); return 1; }
    if (ioctl(fd,UI_SET_EVBIT,EV_KEY)<0){ perror("SET_EVBIT"); return 1; }
    if (ioctl(fd,UI_SET_KEYBIT,KEY_LEFTALT)<0){ perror("SET_KEYBIT"); return 1; }
    struct uinput_setup up; memset(&up,0,sizeof(up));
    up.id.bustype=BUS_USB; up.id.vendor=0x1234; up.id.product=0x5678;
    snprintf(up.name, UINPUT_MAX_NAME_SIZE, "aiarch-keepalive");
    if (ioctl(fd,UI_DEV_SETUP,&up)<0){ perror("SETUP"); return 1; }
    if (ioctl(fd,UI_DEV_CREATE,0)<0){ perror("CREATE"); return 1; }
    int ticks=0;
    while (running){
        ev(fd,EV_KEY,KEY_LEFTALT,1);
        ev(fd,EV_SYN,0,0);
        ev(fd,EV_KEY,KEY_LEFTALT,0);
        ev(fd,EV_SYN,0,0);
        ticks++;
        if (ticks%10==0) fprintf(stderr,"keepalive tick %d\n",ticks);
        for (int i=0;i<300 && running;i++) usleep(100000);
    }
    ioctl(fd,UI_DEV_DESTROY,0);
    close(fd);
    return 0;
}
