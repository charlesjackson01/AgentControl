/* Direct CPUID probe: SVM bit, hypervisor bit, hypervisor signature, LA57. */
#include <stdio.h>
#include <stdint.h>
#include <cpuid.h>

static void cpuid(unsigned leaf, unsigned sub, unsigned out[4]) {
    __cpuid_count(leaf, sub, out[0], out[1], out[2], out[3]);
}

int main(void) {
    unsigned maxleaf[4], extmax[4];
    cpuid(0x0, 0, maxleaf);
    cpuid(0x80000000, 0, extmax);

    unsigned eax1[4];
    cpuid(0x1, 0, eax1);
    int hv = (eax1[0] >> 31) & 1;

    unsigned ext1[4] = {0, 0, 0, 0};
    int svm = 0, la57 = 0;
    if (extmax[0] >= 0x80000001) {
        cpuid(0x80000001, 0, ext1);
        svm = (ext1[0] >> 2) & 1;
    }
    if (extmax[0] >= 0x80000008) {
        unsigned e8[4];
        cpuid(0x80000008, 0, e8);
        la57 = (e8[0] >> 16) & 1;
    }

    unsigned hvsig[4] = {0, 0, 0, 0};
    if (hv) cpuid(0x40000000, 0, hvsig);

    printf("maxleaf=0x%x extmax=0x%x\n", maxleaf[0], extmax[0]);
    printf("CPUID.1:EAX=0x%08x hypervisor_bit=%d\n", eax1[0], hv);
    if (hv) {
        printf("hypervisor sig: %c%c%c%c %c%c%c%c %c%c%c%c\n",
               hvsig[0] & 0xff, (hvsig[0] >> 8) & 0xff, (hvsig[0] >> 16) & 0xff, (hvsig[0] >> 24) & 0xff,
               hvsig[1] & 0xff, (hvsig[1] >> 8) & 0xff, (hvsig[1] >> 16) & 0xff, (hvsig[1] >> 24) & 0xff,
               hvsig[2] & 0xff, (hvsig[2] >> 8) & 0xff, (hvsig[2] >> 16) & 0xff, (hvsig[2] >> 24) & 0xff);
    }
    printf("CPUID.80000001:EAX=0x%08x SVM_bit=%d\n", ext1[0], svm);
    printf("LA57=%d\n", la57);
    return 0;
}
