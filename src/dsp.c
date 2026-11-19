// Bulk operations on the analyzer's precomputed Float64 tables. No imports,
// allocation or audio I/O. See build.py for the reproducible WebAssembly build.
void resample(const double *input, const double *kernels, const int *offset,
              const int *phase, double *output, int length, int taps) {
    for (int i = 0; i < length; ++i) {
        const double *x = input + offset[i];
        const double *k = kernels + phase[i] * taps;
        double sum = 0;
        for (int j = 0; j < taps; ++j) sum += x[j] * k[j];
        output[i] = sum;
    }
}

void fftpower(const double *input, const double *window, const int *reversed,
              const double *cosine, const double *sine, double *real,
              double *imag, double *power, int length) {
    for (int i = 0; i < length; ++i) {
        real[reversed[i]] = window[i] * input[i];
        imag[i] = 0;
    }
    for (int span = 2; span <= length; span *= 2) {
        int half = span / 2, stride = length / span;
        for (int block = 0; block < length; block += span) {
            for (int j = 0; j < half; ++j) {
                int a = block + j, b = a + half, w = j * stride;
                double r = real[b] * cosine[w] - imag[b] * sine[w];
                double t = real[b] * sine[w] + imag[b] * cosine[w];
                real[b] = real[a] - r;
                imag[b] = imag[a] - t;
                real[a] += r;
                imag[a] += t;
            }
        }
    }
    for (int k = 0; k < length / 2; ++k)
        power[k] += real[k] * real[k] + imag[k] * imag[k];
}
