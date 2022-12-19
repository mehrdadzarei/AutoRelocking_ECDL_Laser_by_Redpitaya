/*
 * Red Pitaya Relocking ECDL Application
 *
 * Author: Mehrdad Zarei <mzarei@umk.pl>
 * Date: 2022.06.21
 *
 * (c) Red Pitaya  http://www.redpitaya.com
 */



#include <limits.h>
#include <math.h>
#include <stdio.h>
#include <pthread.h>
#include <stdlib.h>
#include <unistd.h>
#include <sys/types.h>
#include <sys/sysinfo.h>
#include <sys/socket.h>
#include <arpa/inet.h>

#include "main.h"



#define SIGNAL_SIZE_DEFAULT      1024
#define SIGNAL_UPDATE_INTERVAL      1   // ms
#define PARAM_UPDATE_INTERVAL      1    // ms
#define NUM_THREADS 2
#define HEADER 64
#define PORT 5015
#define SERVER "192.168.0.154" // private
#define DISCONNECT_MESSAGE "D"

pthread_t thread_handler[NUM_THREADS];
bool scan_thread_running = false;
bool wlm_thread_running = false;
int sock, client;
struct sockaddr_in address;

uint32_t buff_size = 16 * 1024;
float *buff1 = (float *)malloc(buff_size * sizeof(float));
float *buff1_avg = (float *)malloc(buff_size * sizeof(float));
float *buff2 = (float *)malloc(buff_size * sizeof(float));
// bool fillState = false;

bool appState = false;
rp_acq_decimation_t dec = RP_DEC_8192;
int tDelay = 1000000;   // delay us to start acquiring fresh data

float transmision = 0;
const float scan_lev = 6.0;
const float piezo_step = 0.001;     // v
const float piezo_max = 1.0;        // v
const float piezo_min = -1.0;       // v
float piezo_last_value = 0;
int piezo_delay = SIGNAL_UPDATE_INTERVAL * 2000;   // delay us to apply new value for piezo
float trg_freq = 0;
float freq_diff = 0;

//Signals
CFloatSignal ch1("ch1", SIGNAL_SIZE_DEFAULT, 0.0f);
CFloatSignal ch1_avg("ch1_avg", SIGNAL_SIZE_DEFAULT, 0.0f);

// Parameters
CBooleanParameter APP_RUN("APP_RUN", CBaseParameter::RW, false, 0);
CBooleanParameter AUTO_SCALE("AUTO_SCALE", CBaseParameter::RW, false, 0);
CFloatParameter TIME_SCALE("TIME_SCALE", CBaseParameter::RWSA, 0.1, 0, 0, 1000);
CFloatParameter VOLT_SCALE("VOLT_SCALE", CBaseParameter::RWSA, 0.1, 0, 0, 10);
CBooleanParameter CH1_IN_SHOW("CH1_IN_SHOW", CBaseParameter::RW, true, 0);
CBooleanParameter CH2_IN_SHOW("CH2_IN_SHOW", CBaseParameter::RW, true, 0);
CIntParameter CH1_IN_PROBE("CH1_IN_PROBE", CBaseParameter::RW, 1, 0, 0, 100);
CBooleanParameter CH1_IN_GAIN("CH1_IN_GAIN", CBaseParameter::RW, false, 0);
CIntParameter CH2_IN_PROBE("CH2_IN_PROBE", CBaseParameter::RW, 1, 0, 0, 100);
CBooleanParameter CH2_IN_GAIN("CH2_IN_GAIN", CBaseParameter::RW, false, 0);
CBooleanParameter AUTO_LOCK("AUTO_LOCK", CBaseParameter::RW, false, 0);
// CIntParameter FREQUENCY("FREQUENCY", CBaseParameter::RWSA, 20000.0, 0, 1, 50000000);
CFloatParameter CH1_OUT_OFFSET("CH1_OUT_OFFSET", CBaseParameter::RWSA, 0, 0, -1, 1);
// CIntParameter WAVEFORM("WAVEFORM", CBaseParameter::RW, 1, 0, 0, 2);
CIntParameter WLM_CH("WLM_CH", CBaseParameter::RW, 1, 0, 1, 8);
CFloatParameter WAVELENGTH("WAVELENGTH", CBaseParameter::RWSA, 0, 0, -10, 10000);
CFloatParameter FREQUENCY("FREQUENCY", CBaseParameter::RWSA, 0, 0, -10, 10000);
CFloatParameter TARGET_FREQUENCY("TARGET_FREQUENCY", CBaseParameter::RW, 0, 0, -10, 10000);



// thread for wavemeter
void *wavemeter_thread(void *args) {

    wlm_thread_running = true;
    char* ch = "1";
    char wavel[11] = {};
    char freq[11] = {};
    float diff = 0;
    
    while(wlm_thread_running) {
        
        switch (WLM_CH.Value()) {
            case 1:
                ch = "1";
                break;
            case 2:
                ch = "2";
                break;
            case 3:
                ch = "3";
                break;
            case 4:
                ch = "4";
                break;
            case 5:
                ch = "5";
                break;
            case 6:
                ch = "6";
                break;
            case 7:
                ch = "7";
                break;
            case 8:
                ch = "8";
                break;
        
            default:
                ch = "1";
                break;
        }
        
        send(sock, ch, strlen(ch), 0);
        read(sock, (char*)wavel, 11);
        read(sock, (char*)freq, 11);

        WAVELENGTH.Set(atof(wavel));
        FREQUENCY.Set(atof(freq));

        diff = fabs(trg_freq - FREQUENCY.Value());
        if(diff < 50) {
            freq_diff = diff;
        }

        usleep(1000);
    }

    send(sock, DISCONNECT_MESSAGE, strlen(DISCONNECT_MESSAGE), 0);
    wlm_thread_running = false;
    // closing the connected socket
    close(client);
    pthread_exit(NULL);
}

// scanning
int scanning(float per = 1.0) {

    piezo_last_value = CH1_OUT_OFFSET.Value();
    float scan_range = (piezo_max - piezo_min) * per / 2;
    float min_scan = piezo_last_value - scan_range;
    min_scan = min_scan < piezo_min ? piezo_min : min_scan;
    float max_scan = piezo_last_value + scan_range;
    max_scan = max_scan > piezo_max ? piezo_max : max_scan;
    int len_right_scan = floor((max_scan - piezo_last_value) / piezo_step);
    int len_scan = floor((max_scan - min_scan) * 2 / piezo_step);
    float curr_val = 0.0;
    float prev_freq_diff = freq_diff;

    for(int i = 0; i < len_scan; i++) {

        if(transmision > scan_lev || !scan_thread_running) {
            break;
        }
        
        if(i < len_right_scan) {
            
            curr_val = piezo_last_value + i * piezo_step;
            curr_val = curr_val > piezo_max ? piezo_max : curr_val;

            if(freq_diff > prev_freq_diff * 1.1) {
                i = len_right_scan - 1;
                max_scan = curr_val;
                prev_freq_diff = freq_diff;
                continue;
            }
            if(i == len_right_scan - 1) {
                prev_freq_diff = freq_diff;
            }
        } else if(i < (len_right_scan + (len_scan / 2))) {
            
            curr_val = max_scan + (len_right_scan - i) * piezo_step;
            curr_val = curr_val < piezo_min ? piezo_min : curr_val;

            if(freq_diff > prev_freq_diff * 1.1) {
                i = (len_right_scan + (len_scan / 2)) - 1;
                min_scan = curr_val;
                prev_freq_diff = freq_diff;
                continue;
            }
        } else {
            curr_val = min_scan + (i - (len_right_scan + (len_scan / 2))) * piezo_step;
            curr_val = curr_val > piezo_max ? piezo_max : curr_val;
        }

        rp_GenOffset(RP_CH_1, curr_val);
        CH1_OUT_OFFSET.Set(curr_val);
        usleep(piezo_delay);
    }

    if(min_scan == piezo_min && max_scan == piezo_max) {
        return 0;
    }
    return 1;
}

// thread scan piezo
void *piezo_scan_thread(void *args) {
    
    scan_thread_running = true;
    int repeat = 1;
    int i = 1;
    
    // scanning whole range of piezo
    while (repeat) {
            
        if(transmision > scan_lev || !scan_thread_running) {
            break;
        }
        
        repeat = scanning(i * 0.1);
        i++;
    }

    scan_thread_running = false;
    pthread_exit(NULL);
}

void analyseData(int mul1) {

    float *n_b = (float *)malloc(buff_size * sizeof(float));
    float sum = 0;
    int lev = 0;
    const int no_avr = 500;
    memcpy(n_b, buff1, buff_size);
    
    for(int i = no_avr ; i < buff_size - no_avr ; i++ ){
        
        sum = 0;
        for (int j = -no_avr ; j < no_avr ; j++ ){
            sum += buff1[i + j];
        }
        
        n_b[i - no_avr] = sum / (no_avr * 2);
        
        if(AUTO_LOCK.Value()) {
            
            transmision = n_b[i - no_avr] * mul1;
            if(transmision < scan_lev && !scan_thread_running) {
        
                lev++;
                if(lev > 100) {

                    pthread_create(&thread_handler[1], NULL, piezo_scan_thread, NULL);
                    lev = 0;
                }
            } else {
                lev = 0;
            }
        }
    }
    memcpy(buff1_avg, n_b, buff_size);
    free(n_b);
}

// Generator config
void set_generator_config()
{
    //Set frequency
    // rp_GenFreq(RP_CH_1, 20000);

    //Set offset
    rp_GenOffset(RP_CH_1, CH1_OUT_OFFSET.Value());

    //Set amplitude
    rp_GenAmp(RP_CH_1, 0);

    //Set waveform
    rp_GenWaveform(RP_CH_1, RP_WAVEFORM_DC);
}

// get decimation
void get_decimation() {

    float cal_dec = (ADC_SAMPLE_RATE / ADC_BUFFER_SIZE) * TIME_SCALE.Value() / 100;   // 100 = 10(whole range)/1000(to second)
    
    /* Find optimal decimation setting */
    if(cal_dec < 1) {
        dec = RP_DEC_1;
        tDelay = 131;
    } else if(cal_dec < 8) {
        dec = RP_DEC_8;
        tDelay = 1048;
    } else if(cal_dec < 64) {
        dec = RP_DEC_64;
        tDelay = 8388;
    } else if(cal_dec < 1024) {
        dec = RP_DEC_1024;
        tDelay = 134200;
    } else if(cal_dec < 8192) {
        dec = RP_DEC_8192;
        tDelay = 1000000;
    } else if(cal_dec < 65536) {
        dec = RP_DEC_65536;
        tDelay = 8589000;
    } else {
        dec = RP_DEC_8192;
        tDelay = 1000000;
    }
}

// set acquir
void set_acquir() {

    rp_AcqReset();
    
    rp_AcqSetDecimation(dec);
    // rp_AcqSetAveraging(true);
    // rp_AcqSetTriggerLevel(RP_T_CH_1, 0);
    // rp_AcqSetTriggerDelay(ADC_BUFFER_SIZE/2.0);
    if(CH1_IN_GAIN.Value()) {
        rp_AcqSetGain(RP_CH_1, RP_HIGH);
    } else {
        rp_AcqSetGain(RP_CH_1, RP_LOW);
    }

    if(CH2_IN_GAIN.Value()) {
        rp_AcqSetGain(RP_CH_2, RP_HIGH);
    } else {
        rp_AcqSetGain(RP_CH_2, RP_LOW);
    }

    rp_AcqStart();
    /* After acquisition is started some time delay is needed in order to acquire fresh samples in to buffer*/
    /* Here we have used time delay of one second but you can calculate exact value taking in to account buffer*/
    /*length and smaling rate. Time scale/length of a buffer for decimation 8 takes 1.049 ms to full 16 KS in buffer*/
    usleep(tDelay);
    // rp_AcqSetTriggerSrc(RP_TRIG_SRC_CHA_PE);
}

// Run or stop APP
void run_app() {
    
    // Init generator
    rp_GenReset();
    set_generator_config();
    rp_GenOutEnable(RP_CH_1);

    // Init acquire signal
    get_decimation();
    set_acquir();

    // start communication with wavemeter
    sock = socket(AF_INET, SOCK_STREAM, 0);
    address.sin_family = AF_INET;
    address.sin_port = htons(PORT);
    address.sin_addr.s_addr = inet_addr(SERVER);//inet_addr(SERVER); // INADDR_ANY;
    client = connect(sock, (struct sockaddr *)&address, sizeof (address));
    
    if(client >= 0) {
        pthread_create(&thread_handler[0], NULL, wavemeter_thread, NULL);
    }

    appState = true;
}

void stop_app() {
    
    scan_thread_running = false;
    wlm_thread_running = false;
    appState = false;
    
    // stop acqusition
    rp_AcqStop();

    // Disabe generator
    rp_GenOutDisable(RP_CH_1);
}

const char *rp_app_desc(void)
{
    return (const char *)"Red Pitaya Relocking ECDL.\n";
}

int rp_app_init(void)
{
    fprintf(stderr, "Loading Relocking ECDL application\n");

    // Initialization of API
    if (rpApp_Init() != RP_OK) 
    {
        fprintf(stderr, "Red Pitaya API init failed!\n");
        return EXIT_FAILURE;
    }
    else fprintf(stderr, "Red Pitaya API init success!\n");

    //Set signal and param update interval
    CDataManager::GetInstance()->SetSignalInterval(SIGNAL_UPDATE_INTERVAL);
    CDataManager::GetInstance()->SetParamInterval(PARAM_UPDATE_INTERVAL);

    if(APP_RUN.Value() == true) {
        run_app();
    }

    return 0;
}

int rp_app_exit(void)
{
    scan_thread_running = false;
    wlm_thread_running = false;
    appState = false;
    
    fprintf(stderr, "Unloading Relocking ECDL application\n");

    // stop acqusition
    rp_AcqStop();

    free(buff1);
    free(buff1_avg);
    free(buff2);

    // Disabe generator
    rp_GenOutDisable(RP_CH_1);

    // stop threads
    pthread_exit(NULL);

    // closing the connected socket
    // close(client);

    rpApp_Release();

    return 0;
}

int rp_set_params(rp_app_params_t *p, int len)
{
    return 0;
}

int rp_get_params(rp_app_params_t **p)
{
    return 0;
}

int rp_get_signals(float ***s, int *sig_num, int *sig_len)
{
    return 0;
}

void UpdateSignals(void)
{
    int mul1 = CH1_IN_PROBE.Value();
    int mul2 = CH2_IN_PROBE.Value();
    // fillState = false;
    // rp_acq_trig_state_t state = RP_TRIG_STATE_TRIGGERED;

    if(appState && (CH1_IN_SHOW.Value() || CH2_IN_SHOW.Value())) {

        // while(1){
        //     rp_AcqGetTriggerState(&state);
        //     if(state == RP_TRIG_STATE_TRIGGERED){
        //         break;
        //     }
        // }

        // while(!fillState){
        //     rp_AcqGetBufferFillState(&fillState);
        // }

        if(CH1_IN_SHOW.Value()) {
            rp_AcqGetOldestDataV(RP_CH_1, &buff_size, buff1);
        }
        if(CH2_IN_SHOW.Value()) {
            rp_AcqGetOldestDataV(RP_CH_2, &buff_size, buff2);
        }
        analyseData(mul1);
    }
    
    // int cap_s = floor((TIME_SCALE.Value() / 100) * ADC_SAMPLE_RATE / dec);
    // if (cap_s > ADC_BUFFER_SIZE) {
    //     cap_s = ADC_BUFFER_SIZE;
    // } else if(cap_s < SIGNAL_SIZE_DEFAULT) {
    //     cap_s = SIGNAL_SIZE_DEFAULT;
    // }
    // int avg_s = floor(cap_s / SIGNAL_SIZE_DEFAULT);
    // avg_s = avg_s < 1 ? 1: avg_s;
    // float sum1 = 0, sum2 = 0;
    for(int i = 0; i < SIGNAL_SIZE_DEFAULT; i++) {
    //     for(int j = 0; j < avg_s; j++) {
            
    //         sum1 += buff1[(i * avg_s) + j] * mul1;
    //         sum2 += buff2[(i * avg_s) + j] * mul2;
    //     }
    //     ch1[i] = sum1 / avg_s;
    //     ch1_avg[i] = sum2 / avg_s;
    //     sum1 = 0;
    //     sum2 = 0;
        ch1[i] = buff1[i] * mul1;
        ch1_avg[i] = buff1_avg[i] * mul1;
    }
}

void UpdateParams(void){}

void OnNewParams(void)
{
    float old_time_scale = TIME_SCALE.Value();
    bool ch1_gain = CH1_IN_GAIN.Value();
    bool ch2_gain = CH2_IN_GAIN.Value();
    float ch1_offset = CH1_OUT_OFFSET.Value();
    
    APP_RUN.Update();
    AUTO_SCALE.Update();
    TIME_SCALE.Update();
    CH1_IN_SHOW.Update();
    CH2_IN_SHOW.Update();
    CH1_IN_PROBE.Update();
    CH1_IN_GAIN.Update();
    CH2_IN_PROBE.Update();
    CH2_IN_GAIN.Update();
    AUTO_LOCK.Update();
    CH1_OUT_OFFSET.Update();
    WLM_CH.Update();
    TARGET_FREQUENCY.Update();

    // Run or stop APP
    if(APP_RUN.Value() != appState) {
        if (APP_RUN.Value() == true) {
            
            run_app();
            old_time_scale = TIME_SCALE.Value();
        } else {
            
            stop_app();
        }
    }

    // stop running thread
    if(!AUTO_LOCK.Value()) {
        scan_thread_running = false;
    }

    // change decimation if needed
    if((TIME_SCALE.Value() != old_time_scale || ch1_gain != CH1_IN_GAIN.Value() || ch2_gain != CH2_IN_GAIN.Value()) && appState) {
        
        int curr_dec = dec;

        get_decimation();

        if(curr_dec != dec || ch1_gain != CH1_IN_GAIN.Value() || ch2_gain != CH2_IN_GAIN.Value()) {

            appState = false;
            
            rp_AcqStop();
            set_acquir();
            // rp_AcqSetDecimation(dec);

            appState = true;
        }
    }

    // apply manually new value for piezo
    if(ch1_offset != CH1_OUT_OFFSET.Value() && appState && !scan_thread_running) {
        rp_GenOffset(RP_CH_1, CH1_OUT_OFFSET.Value());
        piezo_last_value = CH1_OUT_OFFSET.Value();
    }

    trg_freq = TARGET_FREQUENCY.Value();
}

void OnNewSignals(void){}

void PostUpdateSignals(void){}



