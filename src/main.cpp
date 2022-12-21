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
#include <string>
#include <unistd.h>
#include <sys/types.h>
#include <sys/sysinfo.h>
#include <sys/socket.h>
#include <arpa/inet.h>

#include "libjson/libjson.h"
#include "main.h"



/* to avoid error of: 
"the function is not declared in your scope"
we have to define the function before specific function or declared here
*/ 
void send_out_gen1(float val);
void send_out_gen2(float val);

#define SIGNAL_SIZE_DEFAULT      1024
#define SIGNAL_UPDATE_INTERVAL      1   // ms
#define PARAM_UPDATE_INTERVAL      1    // ms
#define NUM_THREADS 2
#define HEADER 64
// #define PORT 5015
// #define SERVER "192.168.0.154" // private
#define DISCONNECT_MESSAGE "!DISCONNECT"
#define MAX(a,b) (((a)>(b))?(a):(b))
#define MIN(a,b) (((a)<(b))?(a):(b))

pthread_t thread_handler[NUM_THREADS];
bool scan_thread_running = false;
bool wlm_thread_running = false;
int sock, client;
struct sockaddr_in address;
int ch = 1;
float spec[2000] = {};

uint32_t buff_size = 16 * 1024;
float *buff1 = (float *)malloc(buff_size * sizeof(float));
float *buff1_avg = (float *)malloc(buff_size * sizeof(float));
float *buff2 = (float *)malloc(buff_size * sizeof(float));
// bool fillState = false;

bool appState = false;
rp_acq_decimation_t dec = RP_DEC_8192;
int tDelay = 1000000;   // delay us to start acquiring fresh data

float transmision = 0;
float trans_lev = 0.0;
int lev = 0;                    // number of out of lock
float piezo_step = 0.001;       // v, for Redpitaya 10 bit reseloution is 2 mv
float output_amp1 = 1;          // by default for Redpitaya is +- 1 v which is equalt to 1 amplification
float output_shift1 = 0;         // by default is zero
float piezo_last_value = 0;
float cur_step = 0.001;       // v, for Redpitaya 10 bit reseloution is 2 mv
float output_amp2 = 1;          // by default for Redpitaya is +- 1 v which is equalt to 1 amplification
float output_shift2 = 0;         // by default is zero
float cur_last_value = 0;
int piezo_delay = SIGNAL_UPDATE_INTERVAL * 2000;   // delay us to apply new value for piezo
float trg_freq = 0;
float freq_diff = 0;
const float std_freq_diff = 0.00003;
const int distance_thr = 20;                // find peak in spectrum in this distance
const float hight_thr = 1000;                // find peak in spectrum above this hight
int no_peaks = 0;                           // number of peaks
int no_peaks_diff = 0;
int std_no_peaks_diff = 2;

//Signals
CFloatSignal ch1("ch1", SIGNAL_SIZE_DEFAULT, 0.0f);
CFloatSignal ch1_avg("ch1_avg", SIGNAL_SIZE_DEFAULT, 0.0f);
CFloatSignal spectrum_data("spectrum_data", SIGNAL_SIZE_DEFAULT, 0.0f);

// Parameters
CBooleanParameter APP_RUN("APP_RUN", CBaseParameter::RW, false, 0);
CBooleanParameter AUTO_LOCK("AUTO_LOCK", CBaseParameter::RW, false, 0);
CBooleanParameter LOCK_STATE("LOCK_STATE", CBaseParameter::RWSA, true, 0);
CBooleanParameter AUTO_SCALE("AUTO_SCALE", CBaseParameter::RW, false, 0);

CFloatParameter TIME_SCALE("TIME_SCALE", CBaseParameter::RWSA, 0.1, 0, 0, 1000);
CFloatParameter VOLT_SCALE("VOLT_SCALE", CBaseParameter::RWSA, 0.1, 0, 0, 10);
CBooleanParameter CH1_IN_SHOW("CH1_IN_SHOW", CBaseParameter::RW, true, 0);
CBooleanParameter CH2_IN_SHOW("CH2_IN_SHOW", CBaseParameter::RW, true, 0);
CIntParameter CH1_IN_PROBE("CH1_IN_PROBE", CBaseParameter::RW, 1, 0, 0, 100);
CBooleanParameter CH1_IN_GAIN("CH1_IN_GAIN", CBaseParameter::RW, false, 0);
CIntParameter CH2_IN_PROBE("CH2_IN_PROBE", CBaseParameter::RW, 1, 0, 0, 100);
CBooleanParameter CH2_IN_GAIN("CH2_IN_GAIN", CBaseParameter::RW, false, 0);
CFloatParameter CH1_OUT_MAX("CH1_OUT_MAX", CBaseParameter::RW, 0, 0, -20, 20);
CFloatParameter CH1_OUT_MIN("CH1_OUT_MIN", CBaseParameter::RW, 0, 0, -20, 20);
CFloatParameter CH2_OUT_MAX("CH2_OUT_MAX", CBaseParameter::RW, 0, 0, -20, 20);
CFloatParameter CH2_OUT_MIN("CH2_OUT_MIN", CBaseParameter::RW, 0, 0, -20, 20);

CBooleanParameter CAV_LOCK("CAV_LOCK", CBaseParameter::RW, false, 0);
CBooleanParameter WLM_LOCK("WLM_LOCK", CBaseParameter::RW, false, 0);
CBooleanParameter PIEZO_FEED("PIEZO_FEED", CBaseParameter::RW, false, 0);
CBooleanParameter CUR_FEED("CUR_FEED", CBaseParameter::RW, false, 0);
CFloatParameter TRANS_LVL("TRANS_LVL", CBaseParameter::RW, 0, 0, -20, 20);

CFloatParameter CH1_OUT_OFFSET("CH1_OUT_OFFSET", CBaseParameter::RWSA, 0, 0, -20, 20);
CFloatParameter CH2_OUT_OFFSET("CH2_OUT_OFFSET", CBaseParameter::RWSA, 0, 0, -20, 20);
// CIntParameter WAVEFORM("WAVEFORM", CBaseParameter::RW, 1, 0, 0, 2);

CBooleanParameter WLM_CON("WLM_CON", CBaseParameter::RWSA, true, 0);
CStringParameter WLM_IP("WLM_IP", CBaseParameter::RW, "192.168.0.154", 0);
CIntParameter WLM_PORT("WLM_PORT", CBaseParameter::RW, 5015, 0, 0, 100000);
CIntParameter WLM_CH("WLM_CH", CBaseParameter::RW, 1, 0, 1, 8);
CFloatParameter WAVELENGTH("WAVELENGTH", CBaseParameter::RWSA, 0, 0, -10, 10000);
CFloatParameter FREQUENCY("FREQUENCY", CBaseParameter::RWSA, 0, 0, -10, 10000);
CFloatParameter TARGET_FREQUENCY("TARGET_FREQUENCY", CBaseParameter::RW, 0, 0, -10, 10000);

CFloatParameter MEAN_CH1("MEAN_CH1", CBaseParameter::RWSA, 0.0, 0, -20, 20);
CFloatParameter MEAN_CH2("MEAN_CH2", CBaseParameter::RWSA, 0.0, 0, -20, 20);



int my_send(char msg[]) {

    int len, MSGLEN;
    int pos = 0;
    int total_sent = 0;
    int sent = 1, recvd = 1;
    char* msg_len[100] = {};
    char chunk[100] = {};
    char msg_recv[1] = {};
    
    MSGLEN = strlen(msg);
    sprintf((char*)msg_len, "%d", MSGLEN);
	len = strlen((char*)msg_len);
	memset((char*)msg_len + len, ' ', (HEADER - len));
    msg_len[HEADER] = '\0';

    // waiting for reply
    while(true) {

        recvd = recv(sock, (char*)msg_recv, 1, 0);
        if(recvd <= 0) {
            wlm_thread_running = false;
            return 0;
        }
        if(atoi(msg_recv) == 1){
            break;
        } else if(atoi(msg_recv) == 0) {
            return 0;
        }
    }

    // send msg len
    while(total_sent < HEADER) {

        len = (HEADER - total_sent);
        pos = floor(total_sent / 8);
        memset(chunk, 0, strlen(chunk));
        memcpy(chunk, &msg_len[pos], len);
        sent = send(sock, (char*)chunk, len, 0);
        
        if(sent == 0) {
            wlm_thread_running = false;
            return 0;
        }
        total_sent += sent;
    }

    // waiting for reply
    memset(msg_recv, 0, strlen(msg_recv));
    while(true) {

        recvd = recv(sock, (char*)msg_recv, 1, 0);
        if(recvd <= 0) {
            wlm_thread_running = false;
            return 0;
        }
        if(atoi(msg_recv) == 1){
            break;
        } else if(atoi(msg_recv) == 0) {
            return 0;
        }
    }

    // send msg
    total_sent = 0;
    while(total_sent < MSGLEN) {

        len = (MSGLEN - total_sent);
        memset(chunk, 0, strlen(chunk));
        memcpy(chunk, &msg[total_sent], len);
        sent = send(sock, (char*)chunk, len, 0);
        
        if(sent == 0) {
            wlm_thread_running = false;
            return 0;
        }
        total_sent += sent;
    }

    // waiting for reply
    memset(msg_recv, 0, strlen(msg_recv));
    while(true) {

        recvd = recv(sock, (char*)msg_recv, 1, 0);
        if(recvd <= 0) {
            wlm_thread_running = false;
            return 0;
        }
        if(atoi(msg_recv) == 1){
            break;
        } else if(atoi(msg_recv) == 0) {
            return 0;
        }
    }

    memset(chunk, 0, strlen(chunk));
    memset(msg_len, 0, strlen((char*)msg_len));
    memset(msg_recv, 0, strlen(msg_recv));

    return 1;        
}

int my_recv() {

    int len, MSGLEN;
    int bytes_recvd = 0;
    int recvd = 1;
    char chunk[2050] = {};
    char chunks[15000] = {};
    char msg_send[10] = {};

    JSONNode obj;
    // int json_len;
    float data, ratio;
    JSONNode data_array;
    JSONNode data_child;

    sprintf((char*)msg_send, "1");
    send(sock, (char*)msg_send, strlen(msg_send), 0);

    // recv msg len
    while(bytes_recvd < HEADER) {

        memset(chunk, 0, strlen(chunk));

        recvd = recv(sock, (char*)chunk, MIN(HEADER - bytes_recvd, HEADER), 0);
        
        if(recvd <= 0) {
            wlm_thread_running = false;
            return 0;
        }
        strcat((char*)chunks, (char*)chunk);
        
        bytes_recvd += recvd;
    }

    MSGLEN = atoi(chunks);
    memset(msg_send, 0, strlen(msg_send));

    if(MSGLEN > 0) {
        sprintf((char*)msg_send, "1");
        send(sock, (char*)msg_send, strlen(msg_send), 0);
    } else {
        sprintf((char*)msg_send, "0");
        send(sock, (char*)msg_send, strlen(msg_send), 0);
        return 0;
    }

    // recv msg
    bytes_recvd = 0;
    memset(chunks, 0, strlen(chunks));
    while(bytes_recvd < MSGLEN) {

        memset(chunk, 0, strlen(chunk));

        recvd = recv(sock, (char*)chunk, MIN(MSGLEN - bytes_recvd, 2048), 0);
        
        if(recvd <= 0) {
            wlm_thread_running = false;
            return 0;
        }
        strcat((char*)chunks, (char*)chunk);
        
        bytes_recvd += recvd;
    }
    
    if(strlen(chunks) > 0) {

        obj = libjson::parse(chunks);
        if(!obj.empty()) {

            // json_len = obj.size();

            data = obj.at("WAVEL").as_float();
            WAVELENGTH.Set(data);

            data = obj.at("FREQ").as_float();
            FREQUENCY.Set(data);

            ratio = obj.at("RATIO").as_float();
            data_array = obj.at("SPEC").as_array();
            len = data_array.size();
            
            for(int i = 0; i < len; i++) {
            
                data_child = data_array.at(i);
                spec[i] = data_child.as_float() / ratio;
            }
        }
    }

    sprintf((char*)msg_send, "1");
    send(sock, (char*)msg_send, strlen(msg_send), 0);

    memset(chunk, 0, strlen(chunk));
    memset(chunks, 0, strlen(chunks));
    memset(msg_send, 0, strlen(msg_send));

    return 1;
}

// find multiple peaks in an array
int find_peaks() {

    int cnt = 0;
    int j = 0;
    int index = 0;
    float peak = hight_thr;
    bool find = false;
    int ind_array[100] = {};
    float peak_array[100] = {};

    no_peaks = 0;

    for(int i = 0; i < SIGNAL_SIZE_DEFAULT; i++) {
        cnt = distance_thr + i;
        cnt = ((cnt > SIGNAL_SIZE_DEFAULT) ? SIGNAL_SIZE_DEFAULT:cnt);
        // find peak in the distance range
        for(j = i; j < cnt; j++) {
            // find max in the distance range
            if(spec[j] > hight_thr && spec[j] > peak) {
                index = j;
                peak = spec[j];
                find = true;
            }
        }
        if(find) {
            
            find = false;
            ind_array[no_peaks] = index;
            peak_array[no_peaks] = peak;
            no_peaks++;
        }
        i = --j;
    }
}

// thread for wavemeter
void *wavemeter_thread(void *args) {

    wlm_thread_running = true;
    char msg_send[100] = {};
    float diff = 0;
    
    while(wlm_thread_running) {
        
        memset(msg_send, 0, strlen(msg_send));
        
        sprintf((char*)msg_send, 
                "{\"CH\": %d, \"WAVEL\": %d, \"FREQ\": %d, \"SPEC\": %d}", 
                ch, true, true, true);
        msg_send[strlen(msg_send)] = '\0';
        if(my_send(msg_send) == 0) {
            continue;
        }
        
        if(my_recv() == 0) {
            continue;
        }
        
        if(WLM_LOCK.Value()) {
            
            diff = fabs(trg_freq - FREQUENCY.Value());
            if(diff < 50) {
                freq_diff = diff;
            }
            if(CUR_FEED.Value()) {
                find_peaks();
                MEAN_CH2.Set(no_peaks);
            }
        }else {
            freq_diff = 0;
        }

        usleep(1000);
    }

    memset(msg_send, 0, strlen(msg_send));
    sprintf((char*)msg_send, "{\"STATUS\": \"%s\"}", DISCONNECT_MESSAGE);
    msg_send[strlen(msg_send)] = '\0';
    my_send(msg_send);
    memset(msg_send, 0, strlen(msg_send));
    wlm_thread_running = false;
    WLM_CON.Set(false);
    // closing the connected socket
    shutdown(sock, SHUT_RDWR);
    close(client);
    pthread_exit(NULL);
}

// connect to the Wavemeter
void connect_wlm() {

    // start communication with wavemeter
    sock = socket(AF_INET, SOCK_STREAM, 0);
    address.sin_family = AF_INET;
    address.sin_port = htons(WLM_PORT.Value());
    // address.sin_addr.s_addr = inet_addr(SERVER);    //inet_addr(SERVER); // INADDR_ANY;
    address.sin_addr.s_addr = inet_addr(WLM_IP.Value().c_str());    // if value is string we have to convert it by c_str()
    client = connect(sock, (struct sockaddr *)&address, sizeof (address));
    
    if(client >= 0) {
        WLM_CON.Set(true);
        pthread_create(&thread_handler[0], NULL, wavemeter_thread, NULL);
    }else {
        WLM_CON.Set(false);
    }
}

// scanning
int scanning(float per = 0.2) {

    // if per = 2.0, whole range will be scan and it is good to find target frequency
    float piezo_max = CH1_OUT_MAX.Value();
    float piezo_min = CH1_OUT_MIN.Value();
    piezo_last_value = CH1_OUT_OFFSET.Value();
    float scan_range = (piezo_max - piezo_min) * per / 2;
    float min_scan = piezo_last_value - scan_range;
    min_scan = min_scan <= piezo_min ? piezo_min : min_scan;
    float max_scan = piezo_last_value + scan_range;
    max_scan = max_scan >= piezo_max ? piezo_max : max_scan;
    int len_right_scan = floor((max_scan - piezo_last_value) / piezo_step);
    int len_scan = floor((max_scan - min_scan) * 2 / piezo_step);
    float curr_val = 0.0;
    float prev_freq_diff = freq_diff;

    for(int i = 0; i < len_scan; i++) {

        if(((transmision > trans_lev && CAV_LOCK.Value()) || 
            (freq_diff < std_freq_diff && WLM_LOCK.Value())) || 
            !scan_thread_running) {

            if(!scan_thread_running) {
                break;
            } 
            
            // wait for new information
            sleep(1);
            
            if(CAV_LOCK.Value() && WLM_LOCK.Value()) {
                
                if(transmision > trans_lev && freq_diff < std_freq_diff){
                    break;
                }
            } else if (transmision > trans_lev && CAV_LOCK.Value()) {
                break;
            } else if (freq_diff < std_freq_diff && WLM_LOCK.Value()) {
                break;
            }
        }

        if(freq_diff < std_freq_diff && per == 0.2 && WLM_LOCK.Value()) {                  // very good condition
            
            break;
        } else if(freq_diff < std_freq_diff && per == 0.3 && WLM_LOCK.Value()) {           // very good condition
            
            break;
        } else if(freq_diff < std_freq_diff * 2 && per == 0.5 && WLM_LOCK.Value()) {       // good condition
            
            break;
        } else if(freq_diff < std_freq_diff * 3 && per == 2.0 && WLM_LOCK.Value()) {       // bad condition
            
            break;
        }
        
        if(i < len_right_scan) {
            
            curr_val = piezo_last_value + i * piezo_step;
            curr_val = curr_val >= piezo_max ? piezo_max : curr_val;

            if(freq_diff > (prev_freq_diff + std_freq_diff)) {
                i = len_right_scan - 1;
                max_scan = curr_val;
                prev_freq_diff = freq_diff;
                continue;
            }
            if(i == (len_right_scan - 1) || curr_val == piezo_max) {
                i = len_right_scan - 1;
                prev_freq_diff = freq_diff;
            }
        } else if(i < (len_right_scan + (len_scan / 2))) {
            
            curr_val = max_scan + (len_right_scan - i) * piezo_step;
            curr_val = curr_val <= piezo_min ? piezo_min : curr_val;

            if(freq_diff > (prev_freq_diff + std_freq_diff)) {
                i = (len_right_scan + (len_scan / 2)) - 1;
                min_scan = curr_val;
                prev_freq_diff = freq_diff;
                continue;
            }
            if(curr_val == piezo_min) {
                i = (len_right_scan + (len_scan / 2)) - 1;
            }
        } else {

            curr_val = min_scan + (i - (len_right_scan + (len_scan / 2))) * piezo_step;
            curr_val = curr_val >= piezo_max ? piezo_max : curr_val;
            if(curr_val == piezo_max) {
                i = len_scan;
            }
        }

        send_out_gen1(curr_val);
        CH1_OUT_OFFSET.Set(curr_val);
        usleep(piezo_delay);
    }

    // if(min_scan == piezo_min && max_scan == piezo_max) {
    //     return 0;
    // }
    return 1;
}

// thread scan piezo
void *piezo_scan_thread(void *args) {
    
    scan_thread_running = true;
    int repeat = 1;
    int rng_scan = 1;
    int no_scan = 0;
    int max_no_scan = 2;
    
    // scanning whole range of piezo
    while (repeat) {
            
        if(((transmision > trans_lev && CAV_LOCK.Value()) || 
            (freq_diff < std_freq_diff && WLM_LOCK.Value())) || 
            !scan_thread_running) {

            if(!scan_thread_running) {
                break;
            }
            
            if(CAV_LOCK.Value() && WLM_LOCK.Value()) {
                
                if(transmision > trans_lev && freq_diff < std_freq_diff){
                    break;
                }
            } else if (transmision > trans_lev && CAV_LOCK.Value()) {
                break;
            } else if (freq_diff < std_freq_diff && WLM_LOCK.Value()) {
                break;
            }
        }
        
        // if is not able to find the Mode, stop searching
        if(no_scan == max_no_scan) {

            repeat = 0;
            LOCK_STATE.Set(false);
        }

        // MEAN_CH1.Set(transmision);
        if(WLM_LOCK.Value()) {

            max_no_scan = 5;
            if(freq_diff < std_freq_diff) {                 // very good condition

                piezo_delay = 10000;     // us
                piezo_step = 1 * piezo_step * output_amp1;
                repeat = scanning(0.2);
            } else if(freq_diff < std_freq_diff * 2) {      // good condition

                piezo_delay = 9000;     // us
                piezo_step = 1 * piezo_step * output_amp1;
                repeat = scanning(0.4);
            } else if(freq_diff < std_freq_diff * 3) {      // bad condition

                piezo_delay = 7000;     // us
                piezo_step = 1 * piezo_step * output_amp1;
                repeat = scanning(0.8);
            } else {                                        // very bad condition

                piezo_delay = 5000;     // us
                piezo_step = 1 * piezo_step * output_amp1;
                repeat = scanning(2.0);
                no_scan += 1;
            }
        }else {

            if(rng_scan == 1) {
                
                piezo_delay = 15000;     // us
                piezo_step = 1 * piezo_step * output_amp1;
                repeat = scanning(0.2);
                rng_scan = 2;
            } else if (rng_scan == 2) {
                
                piezo_delay = 15000;     // us
                piezo_step = 1 * piezo_step * output_amp1;
                repeat = scanning(0.4);
                rng_scan = 3;
            } else if (rng_scan == 3) {
                
                piezo_delay = 15000;     // us
                piezo_step = 1 * piezo_step * output_amp1;
                repeat = scanning(0.8);
                rng_scan = 4;
            } else {
                
                piezo_delay = 15000;     // us
                piezo_step = 1 * piezo_step * output_amp1;
                repeat = scanning(rng_scan);
                rng_scan = 1;
                no_scan += 1;
            }
        }// sleep(1);
    }

    scan_thread_running = false;
    lev = 0;
    pthread_exit(NULL);
}

void locking() {

    if(AUTO_LOCK.Value() && LOCK_STATE.Value() && (CAV_LOCK.Value() || WLM_LOCK.Value())) {
            
        if(((transmision < trans_lev && CAV_LOCK.Value()) || 
            (freq_diff > std_freq_diff && WLM_LOCK.Value())) && 
            !scan_thread_running) {
    
            lev++;
            if(lev > 100 || freq_diff > std_freq_diff) {
                pthread_create(&thread_handler[1], NULL, piezo_scan_thread, NULL);
                lev = 0;
            }
        } else {
            lev = 0;
        }
    }
}

void analyseData(int mul, int ch) {

    float *n_b = (float *)malloc(buff_size * sizeof(float));
    float sum = 0;
    const int no_avr = 500;

    if(ch == 1) {
        memcpy(n_b, buff1, buff_size);
    } else {
        memcpy(n_b, buff2, buff_size);
    }
 
    for(int i = no_avr; i < buff_size - no_avr; i++ ){
        
        sum = 0;
        for (int j = -no_avr ; j < no_avr ; j++ ){
            if(ch == 1) {
                sum += buff1[i + j];
            } else {
                sum += buff2[i + j];
            }
        }
        
        n_b[i - no_avr] = sum / (no_avr * 2);
        transmision = n_b[i - no_avr] * mul;
        if(ch == 1 && CH1_IN_SHOW.Value()) {
            MEAN_CH1.Set(transmision);
        } else if(ch == 2) {
            MEAN_CH2.Set(transmision);
            continue;                   // this channel is not for locking
        }
        
        // if is not able to find the Mode but there is Mode, keep this true
        if(transmision > trans_lev) {
            LOCK_STATE.Set(true);
        }
        locking();
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
    send_out_gen1(CH1_OUT_OFFSET.Value());
    send_out_gen2(CH2_OUT_OFFSET.Value());

    //Set amplitude
    rp_GenAmp(RP_CH_1, 0);
    rp_GenAmp(RP_CH_2, 0);

    //Set waveform
    rp_GenWaveform(RP_CH_1, RP_WAVEFORM_DC);
    rp_GenWaveform(RP_CH_2, RP_WAVEFORM_DC);
}

// apply value on output generator 1
void send_out_gen1(float val) {
    
    float final_val = (val - output_shift1) / output_amp1;
    
    if(final_val > 1) {
        final_val = 1;
    }else if(final_val < -1) {
        final_val = -1;
    }

    rp_GenOffset(RP_CH_1, final_val);
}

// apply value on output generator 2
void send_out_gen2(float val) {
    
    float final_val = (val - output_shift2) / output_amp2;
    
    if(final_val > 1) {
        final_val = 1;
    }else if(final_val < -1) {
        final_val = -1;
    }

    rp_GenOffset(RP_CH_2, final_val);
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
    rp_GenOutEnable(RP_CH_2);

    // Init acquire signal
    get_decimation();
    set_acquir();

    // connect to the wavemeter
    connect_wlm();
    
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
    rp_GenOutDisable(RP_CH_2);

    // closing the connected socket
    // shutdown(sock, SHUT_RDWR);
    // close(client);
}

const char *rp_app_desc(void)
{
    return (const char *)"Red Pitaya Relocking ECDL.\obj";
}

int rp_app_init(void)
{
    fprintf(stderr, "Loading Relocking ECDL application\obj");

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
    rp_GenOutDisable(RP_CH_2);

    // stop threads
    pthread_exit(NULL);

    // closing the connected socket
    // shutdown(sock, SHUT_RDWR);
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

    if(appState && 
        (CAV_LOCK.Value() || WLM_LOCK.Value() || CH1_IN_SHOW.Value() || CH2_IN_SHOW.Value())) {

        // while(1){
        //     rp_AcqGetTriggerState(&state);
        //     if(state == RP_TRIG_STATE_TRIGGERED){
        //         break;
        //     }
        // }

        // while(!fillState){
        //     rp_AcqGetBufferFillState(&fillState);
        // }

        // channel 1 from transmission for cavity lock
        if(CAV_LOCK.Value() || CH1_IN_SHOW.Value()) {
            rp_AcqGetOldestDataV(RP_CH_1, &buff_size, buff1);
            analyseData(mul1, 1);
        }
        if(CH2_IN_SHOW.Value()) {
            rp_AcqGetOldestDataV(RP_CH_2, &buff_size, buff2);
            analyseData(mul2, 2);
        }
        if(WLM_LOCK.Value() && !CAV_LOCK.Value()) {
            locking();
        }
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
        ch1[i] = buff1[i] * mul1 - (VOLT_SCALE.Value() - 2.5);
        ch1_avg[i] = buff1_avg[i] * mul1 - (VOLT_SCALE.Value() - 2.5);
        spectrum_data[i] = spec[i];
    }
}

void UpdateParams(void){}

void OnNewParams(void)

{
    float old_time_scale = TIME_SCALE.Value();
    bool ch1_gain = CH1_IN_GAIN.Value();
    bool ch2_gain = CH2_IN_GAIN.Value();
    float ch1_out_max = CH1_OUT_MAX.Value();
    float ch1_out_min = CH1_OUT_MIN.Value();
    float ch2_out_max = CH2_OUT_MAX.Value();
    float ch2_out_min = CH2_OUT_MIN.Value();
    float ch1_offset = CH1_OUT_OFFSET.Value();
    float ch2_offset = CH2_OUT_OFFSET.Value();
    int prev_ch = WLM_CH.Value();
    bool auto_lock_prev = AUTO_LOCK.Value();
    
    APP_RUN.Update();
    AUTO_LOCK.Update();
    AUTO_SCALE.Update();

    TIME_SCALE.Update();
    VOLT_SCALE.Update();
    CH1_IN_SHOW.Update();
    CH2_IN_SHOW.Update();
    CH1_IN_PROBE.Update();
    CH1_IN_GAIN.Update();
    CH2_IN_PROBE.Update();
    CH2_IN_GAIN.Update();
    CH1_OUT_MAX.Update();
    CH1_OUT_MIN.Update();
    CH2_OUT_MAX.Update();
    CH2_OUT_MIN.Update();
    
    CAV_LOCK.Update();
    WLM_LOCK.Update();
    PIEZO_FEED.Update();
    CUR_FEED.Update();
    TRANS_LVL.Update();
    
    CH1_OUT_OFFSET.Update();
    CH2_OUT_OFFSET.Update();
    
    WLM_IP.Update();
    WLM_PORT.Update();
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
    if(AUTO_LOCK.Value() != auto_lock_prev) {

        if(!AUTO_LOCK.Value()) {
            scan_thread_running = false;
        } else {
            LOCK_STATE.Set(true);
        }
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

    // calculate output amplification 1
    if(ch1_out_max != CH1_OUT_MAX.Value() || ch1_out_min != CH1_OUT_MIN.Value()) {
        
        if(CH1_OUT_MAX.Value() <= CH1_OUT_MIN.Value()) {
            CH1_OUT_MAX.Set(1);
            CH1_OUT_MIN.Set(-1);
        }
        output_amp1 = (CH1_OUT_MAX.Value() - CH1_OUT_MIN.Value())/2;
        output_shift1 = (CH1_OUT_MAX.Value() + CH1_OUT_MIN.Value())/2;
        piezo_step *= output_amp1;
    }

    // calculate output amplification 2
    if(ch2_out_max != CH2_OUT_MAX.Value() || ch2_out_min != CH2_OUT_MIN.Value()) {
        
        if(CH2_OUT_MAX.Value() <= CH2_OUT_MIN.Value()) {
            CH2_OUT_MAX.Set(1);
            CH2_OUT_MIN.Set(-1);
        }
        output_amp2 = (CH2_OUT_MAX.Value() - CH2_OUT_MIN.Value())/2;
        output_shift2 = (CH2_OUT_MAX.Value() + CH2_OUT_MIN.Value())/2;
        cur_step *= output_amp2;
    }
    
    // set transmission level
    trans_lev = TRANS_LVL.Value();

    // apply manually new value for piezo
    if(ch1_offset != CH1_OUT_OFFSET.Value() && appState && !scan_thread_running) {
        send_out_gen1(CH1_OUT_OFFSET.Value());
        piezo_last_value = CH1_OUT_OFFSET.Value();
    }

    // apply manually new value for current
    if(ch2_offset != CH2_OUT_OFFSET.Value() && appState && !scan_thread_running) {
        send_out_gen2(CH2_OUT_OFFSET.Value());
        cur_last_value = CH2_OUT_OFFSET.Value();
    }

    trg_freq = TARGET_FREQUENCY.Value();

    if(prev_ch != WLM_CH.Value()) {
        ch = WLM_CH.Value();
    }
}

void OnNewSignals(void){}

void PostUpdateSignals(void){}



