/*
 * Red Pitaya Relocking ECDL Application
 *
 * Author: Mehrdad Zarei <mzarei@umk.pl>
 * Date: 2022.06.21
 *
 * (c) Red Pitaya  http://www.redpitaya.com
 */

(function() {

    if ("performance" in window == false) {
        window.performance = {};
    }

    Date.now = (Date.now || function() { // thanks IE8
        return new Date().getTime();
    });

    if ("now" in window.performance == false) {
        var nowOffset = Date.now();
        if (performance.timing && performance.timing.navigationStart) {
            nowOffset = performance.timing.navigationStart
        }
        window.performance.now = function now() {
            return Date.now() - nowOffset;
        }
    }

})();

(function(APP, $, undefined) {
    
    // App configuration
    APP.running = false;
    APP.startTime = 0;
    APP.config = {};
    APP.config.app_id = 'AutoRelocking_ECDL_Laser_by_Redpitaya';    //have to be the folder name
    APP.config.start_app_url = window.location.origin + '/bazaar?start=' + APP.config.app_id;
    APP.config.stop_app_url = window.location.origin + '/bazaar?stop=' + APP.config.app_id;
    APP.config.socket_url = 'ws://' + window.location.host + '/wss';
    APP.rp_model = "";

    APP.compressed_data = 0;
    APP.parameterStack = [];
    APP.signalStack = [];
    APP.graphs = {};
    APP.loaderShow = false;
    APP.unexpectedClose = false;
    APP.client_id = undefined;

    APP.config.graph_colors = {
        'ch1': '#3276B1',           // like light blue
        'ch1_avg': '#D2322D',       // like red
        'ch2': '#eef52a',           // like yellow
        'ch2_avg': '#2af5cc',       // like mild green
        'spectrum_data': '#009900' // like green
    };

    // Time scale steps in millisecods
    APP.time_steps = [
        // Nanoseconds
        5 / 1000000, 10 / 1000000, 50 / 1000000, 100 / 1000000, 200 / 1000000, 500 / 1000000,
        // Microseconds
        1 / 1000, 2 / 1000, 5 / 1000, 10 / 1000, 20 / 1000, 50 / 1000, 100 / 1000, 200 / 1000, 500 / 1000,
        // Millisecods
        1, 2, 5, 10, 20, 50, 100, 200, 500, 1000
    ];

    // Voltage scale steps in volts
    APP.voltage_steps = [
        // Millivolts
        1 / 1000, 2 / 1000, 5 / 1000, 10 / 1000, 20 / 1000, 50 / 1000, 100 / 1000, 200 / 1000, 500 / 1000,
        // Volts
        1, 2, 5
    ];

    // App state
    APP.state = {
        socket_opened: false,
        processing: false,
        graph_grid_height: null,
        graph_grid_width: null,
        sel_sig_name: 'ch1'
    };

    // Params cache
    APP.params = {
        orig: {},
        old: {},
        local: {}
    };

    // WebSocket
    APP.ws = null;

    var g_PacketsRecv = 0;
    
    // Starts template application on server
    APP.startApp = function() {

        $.get(APP.config.start_app_url)
            .done(function(dresult) {
                if (dresult.status == 'OK') {
                    APP.connectWebSocket();
                } else if (dresult.status == 'ERROR') {
                    console.log(dresult.reason ? dresult.reason : 'Could not start the application (ERR1)');
                    APP.startApp();
                } else {
                    console.log('Could not start the application (ERR2)');
                    APP.startApp();
                }
            })
            .fail(function() {
                console.log('Could not start the application (ERR3)');
                APP.startApp();
            });
    };

    APP.connectWebSocket = function() {

        //Create WebSocket
        if (window.WebSocket) {
            APP.ws = new WebSocket(APP.config.socket_url);
            APP.ws.binaryType = "arraybuffer";
        } else if (window.MozWebSocket) {
            APP.ws = new MozWebSocket(APP.config.socket_url);
            APP.ws.binaryType = "arraybuffer";
        } else {
            console.log('Browser does not support WebSocket');
        }

        // Define WebSocket event listeners
        if (APP.ws) {

            APP.ws.onopen = function() {
                console.log('Socket opened');

                APP.state.socket_opened = true;

                APP.loadParams();
                APP.unexpectedClose = true;
                APP.startTime = performance.now();
                $('body').addClass('loaded');
                $('body').addClass('connection_lost');
                $('body').addClass('user_lost');
                APP.startCheckStatus();
            };

            APP.ws.onclose = function() {
                APP.state.socket_opened = false;
                $('#graphs .plot').hide(); // Hide all graphs
                $('#spec_graph .plot').hide();
                console.log('Socket closed');
                if (APP.unexpectedClose == true) {
                    setTimeout(APP.reloadPage, '1000');
                }
            };

            APP.ws.onerror = function(ev) {
                if (!APP.state.socket_opened)
                    APP.startApp();
                console.log('Websocket error: ', ev);         
            };

            APP.ws.onmessage = function(ev) {
                if (APP.state.processing) {
                    return;
                }
                APP.state.processing = true;

                try {
                    var data = new Uint8Array(ev.data);
                    APP.compressed_data += data.length;
                    var inflate = pako.inflate(data);
                    var text = String.fromCharCode.apply(null, new Uint8Array(inflate));

                    var receive = JSON.parse(text);

                    // console.log(receive);

                    if (receive.parameters) {
                        APP.parameterStack.push(receive.parameters);
                        if ((Object.keys(APP.params.orig).length == 0) && (Object.keys(receive.parameters).length == 0)) {
                            APP.params.local['in_command'] = { value: 'send_all_params' };
                            APP.sendParams();
                        }
                    }

                    if (receive.signals) {
                        // console.log(receive.signals)
                        g_PacketsRecv++;
                        APP.signalStack.push(receive.signals);
                    }
                    APP.state.processing = false;
                } catch (e) {
                    APP.state.processing = false;
                    console.log(e);
                } finally {
                    APP.state.processing = false;
                }
            };
        }
    };

    APP.guiHandler = function() {
        if (APP.signalStack.length > 0) {
            // var p = performance.now();
            APP.processSignals(APP.signalStack[0]);
            APP.signalStack.splice(0, 1);
            // APP.refresh_times.push("tick");
            // console.log("Drawing: " + (performance.now() - p));
        }
        if (APP.signalStack.length > 2)
            APP.signalStack.length = [];
    }

    var parametersHandler = function() {
        if (APP.parameterStack.length > 0) {
            // var p = performance.now();
            APP.processParameters(APP.parameterStack[0]);
            APP.parameterStack.splice(0, 2);
        }
    }

    var performanceHandler = function() {
        $('#throughput_view2').text((APP.compressed_data / 1024).toFixed(2) + "kB/s");
        if ($('#connection_icon').attr('src') !== '../assets/images/good_net.png')
            $('#connection_icon').attr('src', '../assets/images/good_net.png');
        $('#connection_meter').attr('title', 'It seems like your connection is ok');
        if (g_PacketsRecv < 5 || g_PacketsRecv > 25) {
            if ($('#connection_icon').attr('src') !== '../assets/images/bad_net.pngg')
                $('#connection_icon').attr('src', '../assets/images/bad_net.png');
            $('#connection_meter').attr('title', 'Connection problem');
        }

        g_PacketsRecv = 0;
        APP.compressed_data = 0;
    }

    APP.checkStatusTimer = undefined;
    APP.changeStatusForRestart = false;
    APP.changeStatusStep = 0;
    setInterval(performanceHandler, 1000);
    setInterval(parametersHandler, 1);

    APP.reloadPage = function() {
        $.ajax({
            method: "GET",
            url: "/get_client_id",
            timeout: 2000
        }).done(function(msg) {
            if (msg.trim() === APP.client_id) {
                location.reload();
            } else {
                $('body').removeClass('user_lost');
                APP.stopCheckStatus();
            }
        }).fail(function(msg) {
            console.log(msg);
            $('body').removeClass('connection_lost');
        });
    }

    APP.startCheckStatus = function() {
        if (APP.checkStatusTimer === undefined) {
            APP.changeStatusStep = 0;
            APP.checkStatusTimer = setInterval(APP.checkStatus, 4000);
        }
    }

    APP.stopCheckStatus = function() {
        if (APP.checkStatusTimer !== undefined) {
            clearInterval(APP.checkStatusTimer);
            APP.checkStatusTimer = undefined;
        }
    }

    APP.checkStatus = function() {
        $.ajax({
            method: "GET",
            url: "/check_status",
            timeout: 2000
        }).done(function(msg) {
            // console.log("checking OK!")
            switch (APP.changeStatusStep) {
                case 0:
                    APP.changeStatusStep = 1;
                    break;
                case 2:
                    APP.reloadPage();
                    break;
            }
        }).fail(function(msg) {
            // check status. If don't have good state after start. We lock system.
            $('body').removeClass('connection_lost');
            switch (APP.changeStatusStep) {
                case 0:
                    APP.changeStatusStep = -1;
                    break;
                case 1:
                    APP.changeStatusStep = 2;
                    break;
            }

        });
    }

    // Processes newly received values for parameters
    APP.processParameters = function(new_params) {
        
        var pzSl = document.getElementById("piezo");
        var pzN = document.getElementById("piezoN");
        var curSl = document.getElementById("curr");
        var curN = document.getElementById("currN");
        
        var exp_up = document.getElementById("exp_up");
        var exp_down = document.getElementById("exp_down");

        const server_msg = document.getElementById("server_msg");
        const digi_msg = document.getElementById("digi_msg");
        const wavel_txt = document.getElementById("wavel");
        const freq_txt = document.getElementById("freq");
        
        const trg_msg = document.getElementById("trg_msg");
        const graph_msg = document.getElementById("graph_msg");
        const mean_ch1_txt = document.getElementById("mean_ch1");
        const mean_ch2_txt = document.getElementById("mean_ch2");

        if('APP_RUN' in new_params) {
            APP.running = new_params['APP_RUN'].value;
        }
        
        if(!APP.running || APP.params.orig['AUTO_LOCK'].value) {
            pzSl.disabled = true;
            pzN.disabled = true;
            curSl.disabled = true;
            curN.disabled = true;
        } else {
            pzSl.disabled = false;
            pzN.disabled = false;
            curSl.disabled = false;
            curN.disabled = false;
        }

        if(APP.running) {
            
            if('SERVER_CON' in new_params) {
                var server_state = new_params['SERVER_CON'].value;
                if(APP.params.orig['SERVER_RUN'].value && server_state) {
                    server_msg.style.display = "none";
                    // server_msg.innerHTML = "Connected!";
                } else if(APP.params.orig['SERVER_RUN'].value && !server_state) { 
                    
                    server_msg.style.display = "block";
                    // server_msg.innerHTML = "Wavemeter is not Connected!";
                    $("#SERVER_RUN").css('display', 'block');
                    $("#SERVER_STOP").hide();
                    APP.params.orig['SERVER_RUN'] = { value: false };
                }
            }
            
            if('LOCK_STATE' in new_params) {
                var lock_state = new_params['LOCK_STATE'].value;
                if(lock_state) {
                    graph_msg.style.display = "none";
                } else {
                    graph_msg.style.display = "block";
                    $("#man_lock").click();
                }
            }
            
            if('WLM_LOCK' in new_params) {
                var wlm_lock_val = new_params['WLM_LOCK'].value;
                if(wlm_lock_val != undefined && wlm_lock_val != $('#wlm_lock').is(':checked')) {

                    if(APP.params.orig['TARGET_FREQUENCY'].value < 1) {

                        $("#wlm_lock").attr("checked", wlm_lock_val);
                        
                        if($.cookie('TARGET_FREQUENCY') !== undefined) {

                            let txt = 'Target Frequency is NOT Set (last value was ';
                            trg_msg.innerHTML = txt.concat(" ", $.cookie('TARGET_FREQUENCY'), ")");
                        }
                        trg_msg.style.display = "block";
                    }
                }
            }
        
            if('TRANSFER_LOCK' in new_params) {
                
                var transfer_lock_val = new_params['TRANSFER_LOCK'].value;
                if(transfer_lock_val != undefined && transfer_lock_val != $('#transfer_lock').is(':checked')) {
    
                    // here attr function doesn't work to check and uncheck!?
                    document.getElementById("transfer_lock").checked = transfer_lock_val;
                    if(!transfer_lock_val) {
                        
                        digi_msg.innerHTML = 'There is no Peak for Locking on DigiLock, \
                            change Peak to Peak Level or find the Peak manually then apply Lock!';
                        $("#digi_msg").css('display', 'block');
                    }
                }
            }
            
            if('CH1_OUT_OFFSET' in new_params) {
                var pzVal = new_params['CH1_OUT_OFFSET'].value;
                if(pzVal != undefined && pzVal != pzN.value && APP.params.orig['AUTO_LOCK'].value) {
    
                    pzSl.value = pzVal.toFixed(3);
                    pzN.value = pzVal.toFixed(3);
                }
            }
    
            if('CH2_OUT_OFFSET' in new_params) {
                var curVal = new_params['CH2_OUT_OFFSET'].value;
                if(curVal != undefined && curVal != curN.value && APP.params.orig['AUTO_LOCK'].value) {
    
                    curSl.value = curVal.toFixed(3);
                    curN.value = curVal.toFixed(3);
                }
            }
            
            if('EXP_UP' in new_params) {
                var exp_up_val = new_params['EXP_UP'].value;
                if(exp_up_val != undefined && exp_up_val != exp_up.value) {
    
                    exp_up.value = exp_up_val;
                }
            }
    
            if('EXP_DOWN' in new_params) {
                var exp_down_val = new_params['EXP_DOWN'].value;
                if(exp_down_val != undefined && exp_down_val != exp_down.value) {
    
                    exp_down.value = exp_down_val;
                }
            }
            
            if('EXP_AUTO' in new_params) {
                var exp_auto_val = new_params['EXP_AUTO'].value;
                if(exp_auto_val != undefined && exp_auto_val != APP.params.orig['EXP_AUTO'].value) {
    
                    // here attr function doesn't work to check and uncheck!?
                    document.getElementById("exp_auto").checked = exp_auto_val;
                    APP.params.orig['EXP_AUTO'] = { value: exp_auto_val };
                }
            }
    
            if('SWITCH_MODE' in new_params) {
                var switch_mode_val = new_params['SWITCH_MODE'].value;
                if(switch_mode_val != undefined && switch_mode_val != $('#switch_mode').is(':checked')) {
    
                    // here attr function doesn't work to check and uncheck!?
                    document.getElementById("switch_mode").checked = switch_mode_val;
                }
            }
        
            if('DIGI_RUN' in new_params) {
                
                var digi_run_val = new_params['DIGI_RUN'].value;
                if(digi_run_val != undefined && digi_run_val != APP.params.orig['DIGI_RUN'].value) {
    
                    // here attr function doesn't work to check and uncheck!?
                    document.getElementById("digi_run").checked = digi_run_val;
                    APP.params.orig['DIGI_RUN'] = { value: digi_run_val };
                    if(!digi_run_val) {
                        
                        digi_msg.innerHTML = 'DigiLock is not Connected! Check parameters (IP, PORT) or restart DigiLock';
                        $("#digi_msg").css('display', 'block');
                    }
                }
            }
    
            if('MEAN_CH1' in new_params) {
                var mean_ch1_val = new_params['MEAN_CH1'].value;
                if(mean_ch1_val != undefined) {
                    mean_ch1_txt.innerHTML = "Mean In1 [V]: ".concat(" ", mean_ch1_val.toFixed(3));
                }
            }
    
            if('MEAN_CH2' in new_params) {
                var mean_ch2_val = new_params['MEAN_CH2'].value;
                if(mean_ch2_val != undefined) {
                    mean_ch2_txt.innerHTML = "Mean In2 [V]: ".concat(" ", mean_ch2_val.toFixed(3));
                }
            }

            if('WAVELENGTH' in new_params) {
                var wavel_val = new_params['WAVELENGTH'].value;
                if(wavel_val != undefined) {
                    wavel_txt.innerHTML = "Wavelength [nm]: ".concat(" ", wavel_val);
                }
            }
    
            if('FREQUENCY' in new_params) {
                var freq_val = new_params['FREQUENCY'].value;
                if(freq_val != undefined) {
                    freq_txt.innerHTML = "Frequency [THz]: ".concat(" ", freq_val);
                    APP.params.orig['FREQ'] = { value: freq_val };
                }
            }

        }else {
            trg_msg.style.display = "none";
            server_msg.style.display = "none";
            graph_msg.style.display = "none";
            $("#digi_msg").css('display', 'none');
        }
    };

    APP.interpolateArray = function(data, fitCount) {

        var linearInterpolate = function (before, after, atPoint) {
            return before + (after - before) * atPoint;
        };
    
        var newData = new Array();
        var springFactor = new Number((data.length - 1) / (fitCount - 1));
        newData[0] = data[0]; // for new allocation
        for ( var i = 1; i < fitCount - 1; i++) {
            var tmp = i * springFactor;
            var before = new Number(Math.floor(tmp)).toFixed();
            var after = new Number(Math.ceil(tmp)).toFixed();
            var atPoint = tmp - before;
            newData[i] = linearInterpolate(data[before], data[after], atPoint);
        }
        newData[fitCount - 1] = data[data.length - 1]; // for new allocation
        return newData;
    };

    // Processes newly received data for signals
    APP.processSignals = function(new_signals) {
        
        // Do nothing if non of channels are checked
        if (!APP.running ||
            (!$("#CH1_IN_SHOW").data('checked') && 
            !$("#CH2_IN_SHOW").data('checked') && 
            !APP.params.orig['WLM_RUN'].value)) {
            // Hide plots
            $('#graphs .plot').hide();
            $('#spec_graph .plot').hide();
            return;
        }

        var visible_plots = [];
        var pointArr = [];
        var colorsArr = [];
        var pointSpecArr = [];
        var colorsSpecArr = [];
        
        // (Re)Draw every signal
        for (sig_name in new_signals) {

            var len = new_signals[sig_name].size;
            // Ignore empty signals
            if (len == 0)
                continue;

            var color = APP.config.graph_colors[sig_name];

            if(sig_name == 'spectrum_data') {
                
                var pointsSpec = [];
                var interpData = APP.interpolateArray(new_signals[sig_name].value, 2048);
                // console.log(interpData);
                len = interpData.length;
                for (var i = 0; i < len; i++) {
                    pointsSpec.push([i, interpData[i]]);
                }
                pointSpecArr.push(pointsSpec);
                colorsSpecArr.push(color);
                continue;
            } else {

                var points = [];
                for (var i = 0; i < len; i++) {
                    points.push([i, new_signals[sig_name].value[i]]);
                }

                pointArr.push(points);
                colorsArr.push(color);
            }

            if (!APP.loaderShow) {
                $('body').addClass('loaded');
            }
        }

        if (APP.graphs["ch1"]) {
            APP.graphs["ch1"].elem.show();
            APP.graphs["ch1"].plot.setColors(colorsArr);
            APP.graphs["ch1"].plot.resize();
            APP.graphs["ch1"].plot.setupGrid();
            APP.graphs["ch1"].plot.setData(pointArr);
            APP.graphs["ch1"].plot.draw();
        } else {
            APP.redraw_graph(points);
        }

        if (APP.graphs["spec"]) {
            APP.graphs["spec"].elem.show();
            APP.graphs["spec"].plot.setColors(colorsSpecArr);
            APP.graphs["spec"].plot.resize();
            APP.graphs["spec"].plot.setupGrid();
            APP.graphs["spec"].plot.setData(pointSpecArr);
            APP.graphs["spec"].plot.draw();
        } else {
            APP.redraw_spec_graph(pointsSpec);
        }

        visible_plots.push(APP.graphs["ch1"].elem[0]);
        visible_plots.push(APP.graphs["spec"].elem[0]);
        
        // Hide plots without signal
        $('#graphs .plot').not(visible_plots).hide();
        $('#spec_graph .plot').not(visible_plots).hide();
    };

    // Sends to server modified parameters
    APP.sendParams = function(disable_defCur = false) {
        if ($.isEmptyObject(APP.params.local)) {
            return false;
        }

        if (!APP.state.socket_opened) {
            console.log('ERROR: Cannot save changes, socket not opened');
            return false;
        }
        // if (!disable_defCur) APP.setDefCursorVals();
        // console.log(APP.params.local);
        APP.params.local['in_command'] = { value: 'send_all_params' };
        APP.ws.send(JSON.stringify({ parameters: APP.params.local }));
        APP.params.local = {};
        return true;
    };

    APP.redraw_graph = function(points = []) {

        var yrange = APP.params.orig['VOLT_SCALE'].value * 5;
        APP.graphs["ch1"] = {};
        APP.graphs["ch1"].elem = $('<div class="plot" />').css($('#graph_grid').css(['height', 'width'])).appendTo('#graphs');
        APP.graphs["ch1"].plot = $.plot(APP.graphs["ch1"].elem, [points], {
            name: "ch1",
            series: {
                shadowSize: 0, // Drawing is faster without shadows
            },
            yaxis: {
                min: -yrange,
                max: yrange
            },
            xaxis: {
                min: 0
            },
            grid: {
                show: false
            },
            colors: [
                '#FF2A68', '#FF9500', '#FFDB4C', '#87FC70', '#22EDC7', '#1AD6FD', '#C644FC', '#52EDC7', '#EF4DB6'
            ]
        });
    }

    // Draws the grid on the lowest canvas layer
    APP.drawGraphGrid = function() {
        var canvas_width = $('#graphs').width() - 2;
        var canvas_height = Math.round(canvas_width / 6);

        var center_x = canvas_width / 2;
        var center_y = canvas_height / 2;

        var ctx = $('#graph_grid')[0].getContext('2d');

        var x_offset = 0;
        var y_offset = 0;

        // Set canvas size
        ctx.canvas.width = canvas_width;
        ctx.canvas.height = canvas_height;

        // Set draw options
        ctx.beginPath();
        ctx.lineWidth = 1;
        ctx.strokeStyle = '#5d5d5c';

        // Draw ticks
        for (var i = 1; i < 50; i++) {
            x_offset = x_offset + (canvas_width / 50);
            y_offset = y_offset + (canvas_height / 50);

            if (i == 25) {
                continue;
            }

            ctx.moveTo(x_offset, canvas_height - 3);
            ctx.lineTo(x_offset, canvas_height);

            ctx.moveTo(0, y_offset);
            ctx.lineTo(3, y_offset);
        }

        // Draw lines
        x_offset = 0;
        y_offset = 0;

        for (var i = 1; i < 10; i++) {
            x_offset = x_offset + (canvas_height / 10);
            y_offset = y_offset + (canvas_width / 10);

            if (i == 5) {
                continue;
            }

            ctx.moveTo(y_offset, 0);
            ctx.lineTo(y_offset, canvas_height);

            ctx.moveTo(0, x_offset);
            ctx.lineTo(canvas_width, x_offset);
        }

        ctx.stroke();

        // Draw central cross
        ctx.beginPath();
        ctx.lineWidth = 1;
        ctx.strokeStyle = '#999';

        ctx.moveTo(center_x, 0);
        ctx.lineTo(center_x, canvas_height);

        ctx.moveTo(0, center_y);
        ctx.lineTo(canvas_width, center_y);

        ctx.stroke();
    };

    APP.redraw_spec_graph = function(points = []) {

        APP.graphs["spec"] = {};
        APP.graphs["spec"].elem = $('<div class="plot" />').css($('#spec_graph_grid').css(['height', 'width'])).appendTo('#spec_graph');
        APP.graphs["spec"].plot = $.plot(APP.graphs["spec"].elem, [points], {
            name: "spec",
            series: {
                shadowSize: 0, // Drawing is faster without shadows
            },
            yaxis: {
                min: 0,
                max: 4200
            },
            xaxis: {
                min: 0,
                max: 2047
            },
            grid: {
                show: false
            },
            colors: [
                '#FF2A68', '#FF9500', '#FFDB4C', '#87FC70', '#22EDC7', '#1AD6FD', '#C644FC', '#52EDC7', '#EF4DB6'
            ]
        });
    }

    // Draws the spectrum grid on the lowest canvas layer
    APP.drawSpecGraphGrid = function() {
        var canvas_width = $('#spec_graph').width() - 2;
        var canvas_height = Math.round(canvas_width / 3);

        var center_x = canvas_width / 2;
        var center_y = canvas_height / 2;

        var ctx = $('#spec_graph_grid')[0].getContext('2d');

        var x_offset = 0;
        var y_offset = 0;

        // Set canvas size
        ctx.canvas.width = canvas_width;
        ctx.canvas.height = canvas_height;

        // Set draw options
        ctx.beginPath();
        ctx.lineWidth = 1;
        ctx.strokeStyle = '#5d5d5c';

        // Draw ticks
        for (var i = 1; i < 50; i++) {
            x_offset = x_offset + (canvas_width / 50);
            y_offset = y_offset + (canvas_height / 50);

            if (i == 25) {
                continue;
            }

            ctx.moveTo(x_offset, canvas_height - 3);
            ctx.lineTo(x_offset, canvas_height);

            ctx.moveTo(0, y_offset);
            ctx.lineTo(3, y_offset);
        }

        // Draw lines
        x_offset = 0;
        y_offset = 0;

        for (var i = 1; i < 10; i++) {
            x_offset = x_offset + (canvas_height / 10);
            y_offset = y_offset + (canvas_width / 10);

            if (i == 5) {
                continue;
            }

            ctx.moveTo(y_offset, 0);
            ctx.lineTo(y_offset, canvas_height);

            ctx.moveTo(0, x_offset);
            ctx.lineTo(canvas_width, x_offset);
        }

        ctx.stroke();

        // Draw central cross
        ctx.beginPath();
        ctx.lineWidth = 1;
        ctx.strokeStyle = '#999';

        ctx.moveTo(center_x, 0);
        ctx.lineTo(center_x, canvas_height);

        ctx.moveTo(0, center_y);
        ctx.lineTo(canvas_width, center_y);

        ctx.stroke();
    };

    // Load params, should be called just one time
    APP.loadParams = function() {
        
        var ch1_out_max = document.getElementById("ch1_out_max");
        var ch1_out_min = document.getElementById("ch1_out_min");
        var ch2_out_max = document.getElementById("ch2_out_max");
        var ch2_out_min = document.getElementById("ch2_out_min");
        
        var tran_lvl = document.getElementById("tran_lvl");
        
        var pzSl = document.getElementById("piezo");
        var pzN = document.getElementById("piezoN");
        var curSl = document.getElementById("curr");
        var curN = document.getElementById("currN");
        
        var ip = document.getElementById("ip");
        var port = document.getElementById("port");
        var exp_up = document.getElementById("exp_up");
        var exp_down = document.getElementById("exp_down");

        var ip_digi = document.getElementById("digi_ip");
        var port_digi = document.getElementById("digi_port");
        var ptp_lvl = document.getElementById("ptp_lvl");

        APP.params.orig['AUTO_LOCK'] = { value: false };

        if($.cookie('SERVER_RUN') === undefined) {
            
            $("#SERVER_RUN").css('display', 'block');
            $("#SERVER_STOP").hide();
            APP.params.local['SERVER_RUN'] = { value: false };
            APP.params.orig['SERVER_RUN'] = { value: false };
        } else {
            if($.cookie('SERVER_RUN') === "true") {

                $("#SERVER_RUN").hide();
                $("#SERVER_STOP").css('display', 'block');
                APP.params.local['SERVER_RUN'] = { value: true };
                APP.params.orig['SERVER_RUN'] = { value: true };
            } else {
                
                $("#SERVER_RUN").css('display', 'block');
                $("#SERVER_STOP").hide();
                APP.params.local['SERVER_RUN'] = { value: false };
                APP.params.orig['SERVER_RUN'] = { value: false };
            }
        }
        
        if($.cookie('CH1_IN_SHOW') !== "true") {
            $("#CH1_IN_SHOW").data('checked', false).toggleClass('btn-default btn-primary');
            APP.params.local['CH1_IN_SHOW'] = { value: false };
        }else {
            APP.params.local['CH1_IN_SHOW'] = { value: true };
        }

        if($.cookie('CH2_IN_SHOW') !== "true") {
            $("#CH2_IN_SHOW").data('checked', false).toggleClass('btn-default btn-primary');
            APP.params.local['CH2_IN_SHOW'] = { value: false };
        }else {
            APP.params.local['CH2_IN_SHOW'] = { value: true };
        }

        if($.cookie('TIME_SCALE') === undefined) {
            APP.params.local['TIME_SCALE'] = { value: 0.1 };
            APP.params.orig['TIME_SCALE'] = { value: 0.1 };
        } else {
            APP.params.local['TIME_SCALE'] = { value: $.cookie('TIME_SCALE') };
            APP.params.orig['TIME_SCALE'] = { value: $.cookie('TIME_SCALE') };
        }

        if($.cookie('VOLT_SCALE') === undefined) {
            APP.params.orig['VOLT_SCALE'] = { value: 0.5 };
            APP.params.local['VOLT_SCALE'] = { value: 0.5 };
        } else {
            APP.params.orig['VOLT_SCALE'] = { value: $.cookie('VOLT_SCALE') };
            APP.params.local['VOLT_SCALE'] = { value: $.cookie('VOLT_SCALE') };
        }

        $("#CH1_IN_PROBE").val($.cookie('CH1_IN_PROBE'));
        if($.cookie('CH1_IN_PROBE') == "1") {
            APP.params.local['CH1_IN_PROBE'] = { value: 10 };
        }else {
            APP.params.local['CH1_IN_PROBE'] = { value: 1 };
        }

        $("#CH1_IN_GAIN").val($.cookie('CH1_IN_GAIN'));
        if($.cookie('CH1_IN_GAIN') == "1") {
            APP.params.local['CH1_IN_GAIN'] = { value: true };
        }else {
            APP.params.local['CH1_IN_GAIN'] = { value: false };
        }

        $("#CH2_IN_PROBE").val($.cookie('CH2_IN_PROBE'));
        if($.cookie('CH2_IN_PROBE') == "1") {
            APP.params.local['CH2_IN_PROBE'] = { value: 10 };
        }else {
            APP.params.local['CH2_IN_PROBE'] = { value: 1 };
        }

        $("#CH2_IN_GAIN").val($.cookie('CH2_IN_GAIN'));
        if($.cookie('CH2_IN_GAIN') == "1") {
            APP.params.local['CH2_IN_GAIN'] = { value: true };
        }else {
            APP.params.local['CH2_IN_GAIN'] = { value: false };
        }

        if($.cookie('CH1_OUT_MAX') === undefined) {
            
            APP.params.local['CH1_OUT_MAX'] = { value: 1 };
            ch1_out_max.value = 1;
            pzN.max = pzSl.max = 1;
        } else {
            
            APP.params.local['CH1_OUT_MAX'] = { value: $.cookie('CH1_OUT_MAX') };
            ch1_out_max.value = $.cookie('CH1_OUT_MAX');
            pzN.max = pzSl.max = $.cookie('CH1_OUT_MAX');
        }

        if($.cookie('CH1_OUT_MIN') === undefined) {
            
            APP.params.local['CH1_OUT_MIN'] = { value: -1 };
            ch1_out_min.value = -1;
            pzN.min = pzSl.min = -1;
        } else {
            
            APP.params.local['CH1_OUT_MIN'] = { value: $.cookie('CH1_OUT_MIN') };
            ch1_out_min.value = $.cookie('CH1_OUT_MIN');
            pzN.min = pzSl.min = $.cookie('CH1_OUT_MIN');
        }

        if($.cookie('CH2_OUT_MAX') === undefined) {
            APP.params.local['CH2_OUT_MAX'] = { value: 1 };
            ch2_out_max.value = 1;
            curN.max = curSl.max = 1;
        } else {
            APP.params.local['CH2_OUT_MAX'] = { value: $.cookie('CH2_OUT_MAX') };
            ch2_out_max.value = $.cookie('CH2_OUT_MAX');
            curN.max = curSl.max = $.cookie('CH2_OUT_MAX');
        }

        if($.cookie('CH2_OUT_MIN') === undefined) {
            APP.params.local['CH2_OUT_MIN'] = { value: -1 };
            ch2_out_min.value = -1;
            curN.min = curSl.min = -1;
        } else {
            APP.params.local['CH2_OUT_MIN'] = { value: $.cookie('CH2_OUT_MIN') };
            ch2_out_min.value = $.cookie('CH2_OUT_MIN');
            curN.min = curSl.min = $.cookie('CH2_OUT_MIN');
        }

        if($.cookie('CH1_OUT_OFFSET') === undefined) {
            APP.params.local['CH1_OUT_OFFSET'] = { value: 0 };
            pzSl.value = 0;
            pzN.value = 0;
        } else {
            APP.params.local['CH1_OUT_OFFSET'] = { value: $.cookie('CH1_OUT_OFFSET') };
            pzSl.value = $.cookie('CH1_OUT_OFFSET');
            pzN.value = $.cookie('CH1_OUT_OFFSET');
        }

        if($.cookie('CH2_OUT_OFFSET') === undefined) {
            APP.params.local['CH2_OUT_OFFSET'] = { value: 0 };
            curSl.value = 0;
            curN.value = 0;
        } else {
            APP.params.local['CH2_OUT_OFFSET'] = { value: $.cookie('CH2_OUT_OFFSET') };
            curSl.value = $.cookie('CH2_OUT_OFFSET');
            curN.value = $.cookie('CH2_OUT_OFFSET');
        }

        if($.cookie('CAV_LOCK') === undefined) {
            $("#cavity_lock").attr("checked", false);
            APP.params.local['CAV_LOCK'] = { value: false };
        } else {
            if($.cookie('CAV_LOCK') == 'true') {
                $("#cavity_lock").attr("checked", true);
                APP.params.local['CAV_LOCK'] = { value: true };
            }else {
                $("#cavity_lock").attr("checked", false);
                APP.params.local['CAV_LOCK'] = { value: false };
            }
        }

        if($.cookie('TRANS_LVL') === undefined) {
            APP.params.local['TRANS_LVL'] = { value: 0 };
            tran_lvl.value = 0.0;
        } else {
            APP.params.local['TRANS_LVL'] = { value: $.cookie('TRANS_LVL') };
            tran_lvl.value = $.cookie('TRANS_LVL');
        }

        if($.cookie('WLM_LOCK') === undefined) {
            $("#wlm_lock").attr("checked", false);
            APP.params.local['WLM_LOCK'] = { value: false };
        } else {
            if($.cookie('WLM_LOCK') == 'true') {
                $("#wlm_lock").attr("checked", true);
                APP.params.local['WLM_LOCK'] = { value: true };
            }else {
                $("#wlm_lock").attr("checked", false);
                APP.params.local['WLM_LOCK'] = { value: false };
            }
        }
        
        APP.params.orig['TARGET_FREQUENCY'] = { value: 0.0 };

        if($.cookie('PIEZO_FEED') === undefined) {
            $("#piezo_lock").attr("checked", false);
            APP.params.local['PIEZO_FEED'] = { value: false };
        } else {
            if($.cookie('PIEZO_FEED') == 'true') {
                $("#piezo_lock").attr("checked", true);
                APP.params.local['PIEZO_FEED'] = { value: true };
            }else {
                $("#piezo_lock").attr("checked", false);
                APP.params.local['PIEZO_FEED'] = { value: false };
            }
        }

        if($.cookie('CUR_FEED') === undefined) {
            $("#curr_lock").attr("checked", false);
            APP.params.local['CUR_FEED'] = { value: false };
        } else {
            if($.cookie('CUR_FEED') == 'true') {
                $("#curr_lock").attr("checked", true);
                APP.params.local['CUR_FEED'] = { value: true };
            }else {
                $("#curr_lock").attr("checked", false);
                APP.params.local['CUR_FEED'] = { value: false };
            }
        }

        if($.cookie('LASER_DRIFT') === undefined) {
            $("#laser_drift").attr("checked", false);
            APP.params.local['LASER_DRIFT'] = { value: false };
        } else {
            if($.cookie('LASER_DRIFT') == 'true') {
                $("#laser_drift").attr("checked", true);
                APP.params.local['LASER_DRIFT'] = { value: true };
            }else {
                $("#laser_drift").attr("checked", false);
                APP.params.local['LASER_DRIFT'] = { value: false };
            }
        }

        if($.cookie('TRANSFER_LOCK') === undefined) {
            $("#transfer_lock").attr("checked", false);
            APP.params.local['TRANSFER_LOCK'] = { value: false };
        } else {
            if($.cookie('TRANSFER_LOCK') == 'true') {
                $("#transfer_lock").attr("checked", true);
                APP.params.local['TRANSFER_LOCK'] = { value: true };
            }else {
                $("#transfer_lock").attr("checked", false);
                APP.params.local['TRANSFER_LOCK'] = { value: false };
            }
        }

        if($.cookie('WLM_IP') === undefined) {
            APP.params.local['WLM_IP'] = { value: "192.168.0.154" };
            ip.value = "192.168.0.154";
        } else {
            APP.params.local['WLM_IP'] = { value: $.cookie('WLM_IP') };
            ip.value = $.cookie('WLM_IP');
        }

        if($.cookie('WLM_PORT') === undefined) {
            APP.params.local['WLM_PORT'] = { value: 5015 };
            port.value = 5015;
        } else {
            APP.params.local['WLM_PORT'] = { value: $.cookie('WLM_PORT') };
            port.value = $.cookie('WLM_PORT');
        }

        if($.cookie('WLM_RUN') === undefined) {
            
            $("#WLM_RUN").attr("checked", false);
            $("#wlm_info").css('display', 'none');
            APP.params.local['WLM_RUN'] = { value: false };
            APP.params.orig['WLM_RUN'] = { value: false };
        } else {
            if($.cookie('WLM_RUN') === "true") {

                $("#WLM_RUN").attr("checked", true);
                $("#wlm_info").css('display', 'block');
                APP.params.local['WLM_RUN'] = { value: true };
                APP.params.orig['WLM_RUN'] = { value: true };
            } else {
                
                $("#WLM_RUN").attr("checked", false);
                $("#wlm_info").css('display', 'none');
                APP.params.local['WLM_RUN'] = { value: false };
                APP.params.orig['WLM_RUN'] = { value: false };
            }
        }

        if($.cookie('PREC') === undefined) {
            $("#prec").val(5);
            APP.params.local['PREC'] = { value: 5 };
        } else {
            $("#prec").val($.cookie('PREC'));
            APP.params.local['PREC'] = { value: $.cookie('PREC') };
        }

        if($.cookie('WLM_CH') === undefined) {
            $("#WLM_CH").val(1);
            APP.params.local['WLM_CH'] = { value: 1 };
        } else {
            $("#WLM_CH").val($.cookie('WLM_CH'));
            APP.params.local['WLM_CH'] = { value: $.cookie('WLM_CH') };
        }

        if($.cookie('EXP_UP') === undefined) {
            APP.params.local['EXP_UP'] = { value: 2 };
            exp_up.value = 2;
        } else {
            APP.params.local['EXP_UP'] = { value: $.cookie('EXP_UP') };
            exp_up.value = $.cookie('EXP_UP');
        }

        if($.cookie('EXP_DOWN') === undefined) {
            APP.params.local['EXP_DOWN'] = { value: 0 };
            exp_down.value = 0;
        } else {
            APP.params.local['EXP_DOWN'] = { value: $.cookie('EXP_DOWN') };
            exp_down.value = $.cookie('EXP_DOWN');
        }

        if($.cookie('EXP_AUTO') === undefined) {
            $("#exp_auto").attr("checked", false);
            APP.params.local['EXP_AUTO'] = { value: false };
            APP.params.orig['EXP_AUTO'] = { value: false };
        } else {
            if($.cookie('EXP_AUTO') == 'true') {
                $("#exp_auto").attr("checked", true);
                APP.params.local['EXP_AUTO'] = { value: true };
                APP.params.orig['EXP_AUTO'] = { value: true };
            }else {
                $("#exp_auto").attr("checked", false);
                APP.params.local['EXP_AUTO'] = { value: false };
                APP.params.orig['EXP_AUTO'] = { value: false };
            }
        }

        if($.cookie('SWITCH_MODE') === undefined) {
            $("#switch_mode").attr("checked", true);
            APP.params.local['SWITCH_MODE'] = { value: true };
        } else {
            if($.cookie('SWITCH_MODE') == 'true') {
                $("#switch_mode").attr("checked", true);
                APP.params.local['SWITCH_MODE'] = { value: true };
            }else {
                $("#switch_mode").attr("checked", false);
                APP.params.local['SWITCH_MODE'] = { value: false };
            }
        }

        if($.cookie('DIGI_IP') === undefined) {
            APP.params.local['DIGI_IP'] = { value: "192.168.0.175" };
            ip_digi.value = "192.168.0.175";
        } else {
            APP.params.local['DIGI_IP'] = { value: $.cookie('DIGI_IP') };
            ip_digi.value = $.cookie('DIGI_IP');
        }

        if($.cookie('DIGI_PORT') === undefined) {
            APP.params.local['DIGI_PORT'] = { value: 60001 };
            port_digi.value = 60001;
        } else {
            APP.params.local['DIGI_PORT'] = { value: $.cookie('DIGI_PORT') };
            port_digi.value = $.cookie('DIGI_PORT');
        }

        if($.cookie('DIGI_RUN') === undefined) {
            
            $("#digi_run").attr("checked", false);
            $("#digi_msg").css('display', 'none');
            APP.params.local['DIGI_RUN'] = { value: false };
            APP.params.orig['DIGI_RUN'] = { value: false };
        } else {

            $("#digi_msg").css('display', 'none');
            if($.cookie('DIGI_RUN') === "true") {

                $("#digi_run").attr("checked", true);
                APP.params.local['DIGI_RUN'] = { value: true };
                APP.params.orig['DIGI_RUN'] = { value: true };
            } else {
                
                $("#digi_run").attr("checked", false);
                APP.params.local['DIGI_RUN'] = { value: false };
                APP.params.orig['DIGI_RUN'] = { value: false };
            }
        }

        if($.cookie('PTP_LVL') === undefined) {
            APP.params.local['PTP_LVL'] = { value: 0.04 };
            ptp_lvl.value = 0.04;
        } else {
            APP.params.local['PTP_LVL'] = { value: $.cookie('PTP_LVL') };
            ptp_lvl.value = $.cookie('PTP_LVL');
        }

        APP.sendParams();
    };

}(window.APP = window.APP || {}, jQuery));



// Page onload event handler
$(function() {

    if($.cookie("mode") === "dark") {
        document.body.classList.toggle("dark-mode");
    }

    APP.client_id = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        var r = Math.random() * 16 | 0,
            v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });

    $.ajax({
        url: '/set_client_id', //Server script to process data
        type: 'POST',
        //Ajax events
        //beforeSend: beforeSendHandler,
        success: function(e) { console.log(e); },
        error: function(e) { console.log(e); },
        // Form data
        data: APP.client_id,
        //Options to tell jQuery not to process data or worry about content-type.
        cache: false,
        contentType: false,
        processData: false
    });

    APP.checkStatus();

    var ch1_out_max = document.getElementById("ch1_out_max");
    var ch1_out_min = document.getElementById("ch1_out_min");
    var ch2_out_max = document.getElementById("ch2_out_max");
    var ch2_out_min = document.getElementById("ch2_out_min");
    
    var tran_lvl = document.getElementById("tran_lvl");
    
    var pzSl = document.getElementById("piezo");
    var pzN = document.getElementById("piezoN");
    var curSl = document.getElementById("curr");
    var curN = document.getElementById("currN");
    
    var ip = document.getElementById("ip");
    var port = document.getElementById("port");
    var exp_up = document.getElementById("exp_up");
    var exp_down = document.getElementById("exp_down");

    var ip_digi = document.getElementById("digi_ip");
    var port_digi = document.getElementById("digi_port");
    var ptp_lvl = document.getElementById("ptp_lvl");

    const server_msg = document.getElementById("server_msg");
    const trg_msg = document.getElementById("trg_msg");
    const targ_freq_txt = document.getElementById("targ_freq");
    const digi_msg = document.getElementById("digi_msg");
    

    $("#mode").click(function() {
        document.body.classList.toggle("dark-mode");
        if($("body").hasClass("dark-mode")) {
            $.cookie("mode", "dark");
        }else {
            $.cookie("mode", "light");
        }
    });

    $("#SERVER_RUN").click(function() {
        
        $(this).hide();
        $("#SERVER_STOP").css('display', 'block');
        $("#server_info").css('display', 'block');
        $("#digi_msg").css('display', 'none');
        server_msg.style.display = "none";
        $.cookie('SERVER_RUN', true);
        APP.params.orig['SERVER_RUN'] = { value: true };
        APP.params.local['SERVER_RUN'] = { value: true };
        APP.sendParams();
    });

    $("#SERVER_STOP").click(function() {
        
        $(this).hide();
        $("#SERVER_RUN").css('display', 'block');
        $("#server_info").css('display', 'none');
        $.cookie('SERVER_RUN', false);
        APP.params.orig['SERVER_RUN'] = { value: false };
        APP.params.local['SERVER_RUN'] = { value: false };
        APP.sendParams();
    });

    $("#auto_lock").click(function() {
        
        $(this).hide();
        $("#man_lock").css('display', 'block');
        pzSl.disabled = true;
        pzN.disabled = true;
        trg_msg.style.display = "none";
        
        APP.params.local['AUTO_LOCK'] = { value: true };
        APP.params.orig['AUTO_LOCK'] = { value: true };
        APP.sendParams();
    });

    $("#man_lock").click(function() {
        
        $(this).hide();
        $("#auto_lock").css('display', 'block');
        trg_msg.style.display = "none";
        pzSl.disabled = false;
        pzN.disabled = false;
        APP.params.local['AUTO_LOCK'] = { value: false };
        APP.params.orig['AUTO_LOCK'] = { value: false };
        APP.sendParams();
    });

    $("#APP_RUN").click(function() {
        
        $(this).hide();
        $("#APP_STOP").css('display', 'block');
        $("#digi_msg").css('display', 'none');
        APP.params.local['APP_RUN'] = { value: true };
        APP.sendParams();
        APP.signalStack = [];
        setInterval(APP.guiHandler, 40);
    });

    $("#APP_STOP").click(function() {
        
        clearInterval(APP.guiHandler);
        $(this).hide();
        $("#APP_RUN").css('display', 'block');
        APP.params.local['APP_RUN'] = { value: false };
        APP.sendParams();
    });

    $("#CH1_IN_SHOW").click(function() {
        // var other_btn = $(btn.id == 'ch1_show' ? '#ch2_show' : '#ch1_show');
        var btn = $(this);
        var checked = !btn.data('checked');
    
        btn.data('checked', checked).toggleClass('btn-default btn-primary');
        $.cookie('CH1_IN_SHOW', checked);
        APP.params.local['CH1_IN_SHOW'] = { value: checked };
        APP.sendParams();
    });

    $("#CH2_IN_SHOW").click(function() {
        // var other_btn = $(btn.id == 'ch1_show' ? '#ch2_show' : '#ch1_show');
        var btn = $(this);
        var checked = !btn.data('checked');
    
        btn.data('checked', checked).toggleClass('btn-default btn-primary');
        $.cookie('CH2_IN_SHOW', checked);
        APP.params.local['CH2_IN_SHOW'] = { value: checked };
        APP.sendParams();
    });

    $("#x_zoomin").click(function() {
        
        var curr_scale = APP.params.orig['TIME_SCALE'].value;
        var new_scale;

        for (var i = 0; i < APP.time_steps.length - 1; i++) {
            
            if (curr_scale == APP.time_steps[i]) {
                new_scale = APP.time_steps[(i > 0 ? i - 1 : 0)];
                break;
            }
        }

        if (new_scale !== undefined && new_scale > 0 && new_scale != curr_scale) {

            APP.params.local['TIME_SCALE'] = { value: new_scale };
            APP.params.orig['TIME_SCALE'] = { value: new_scale };
            APP.sendParams();
            $.cookie('TIME_SCALE', new_scale);
        }
    });

    $("#x_zoomout").click(function() {
        
        var curr_scale = APP.params.orig['TIME_SCALE'].value;
        var new_scale;

        for (var i = 0; i < APP.time_steps.length - 1; i++) {
            
            if (curr_scale == APP.time_steps[i]) {
                new_scale = APP.time_steps[(i < APP.time_steps.length - 2 ? i + 1 : APP.time_steps.length - 2)];
                break;
            }
        }

        if (new_scale !== undefined && new_scale > 0 && new_scale != curr_scale) {

            APP.params.local['TIME_SCALE'] = { value: new_scale };
            APP.params.orig['TIME_SCALE'] = { value: new_scale };
            APP.sendParams();
            $.cookie('TIME_SCALE', new_scale);
        }
    });

    $("#y_zoomin").click(function() {
        
        var curr_scale = APP.params.orig['VOLT_SCALE'].value;
        var new_scale;

        for (var i = 0; i < APP.voltage_steps.length; i++) {
            
            if (curr_scale == APP.voltage_steps[i]) {
                new_scale = APP.voltage_steps[(i > 0 ? i - 1 : 0)];
                break;
            }
        }

        if (new_scale !== undefined && new_scale > 0 && new_scale != curr_scale) {

            APP.params.orig['VOLT_SCALE'] = { value: new_scale };
            APP.params.local['VOLT_SCALE'] = { value: new_scale };
            $.cookie('VOLT_SCALE', new_scale);
            APP.redraw_graph();
            console.log(new_scale);
            APP.sendParams();
        }
    });

    $("#y_zoomout").click(function() {
        
        var curr_scale = APP.params.orig['VOLT_SCALE'].value;
        var new_scale;

        for (var i = 0; i < APP.voltage_steps.length; i++) {
            
            if (curr_scale == APP.voltage_steps[i]) {
                new_scale = APP.voltage_steps[(i < APP.voltage_steps.length - 1 ? i + 1 : APP.voltage_steps.length - 1)];
                break;
            }
        }

        if (new_scale !== undefined && new_scale > 0 && new_scale != curr_scale) {

            APP.params.orig['VOLT_SCALE'] = { value: new_scale };
            APP.params.local['VOLT_SCALE'] = { value: new_scale };
            $.cookie('VOLT_SCALE', new_scale);
            APP.redraw_graph();
            console.log(new_scale);
            APP.sendParams();
        }
    });

    $("#CH1_IN_PROBE").change(function() {
        var val = $(this).children("option:selected").val();
        $.cookie('CH1_IN_PROBE', val);
        if(val == 1) {
            APP.params.local['CH1_IN_PROBE'] = { value: 10 };   // 10x
        }else {
            APP.params.local['CH1_IN_PROBE'] = { value: 1 };   // 1x
        }
        APP.sendParams();
    });

    $("#CH1_IN_GAIN").change(function() {
        var val = $(this).children("option:selected").val();
        $.cookie('CH1_IN_GAIN', val);
        if(val == 1) {
            APP.params.local['CH1_IN_GAIN'] = { value: true };   // HV
        }else {
            APP.params.local['CH1_IN_GAIN'] = { value: false };     // LV
        }
        APP.sendParams();
    });

    $("#CH2_IN_PROBE").change(function() {
        var val = $(this).children("option:selected").val();
        $.cookie('CH2_IN_PROBE', val);
        if(val == 1) {
            APP.params.local['CH2_IN_PROBE'] = { value: 10 };   // 10x
        }else {
            APP.params.local['CH2_IN_PROBE'] = { value: 1 };    // 1x
        }
        APP.sendParams();
    });

    $("#CH2_IN_GAIN").change(function() {
        var val = $(this).children("option:selected").val();
        $.cookie('CH2_IN_GAIN', val);
        if(val == 1) {
            APP.params.local['CH2_IN_GAIN'] = { value: true };   // HV
        }else {
            APP.params.local['CH2_IN_GAIN'] = { value: false };     // LV
        }
        APP.sendParams();
    });

    ch1_out_max.onchange = function() {
        
        this.value = this.value > 20 ? this.max : this.value;
        this.value = this.value < -20 ? this.min : this.value;
        pzN.max = pzSl.max = this.value;

        $.cookie('CH1_OUT_MAX', this.value);
        APP.params.local['CH1_OUT_MAX'] = { value: this.value };
        APP.sendParams();
    }

    ch1_out_min.onchange = function() {
        
        this.value = this.value > 20 ? this.max : this.value;
        this.value = this.value < -20 ? this.min : this.value;
        pzN.min = pzSl.min = this.value;

        $.cookie('CH1_OUT_MIN', this.value);
        APP.params.local['CH1_OUT_MIN'] = { value: this.value };
        APP.sendParams();
    }

    ch2_out_max.onchange = function() {
        
        this.value = this.value > 20 ? this.max : this.value;
        this.value = this.value < -20 ? this.min : this.value;
        curN.max = curSl.max = this.value;

        $.cookie('CH2_OUT_MAX', this.value);
        APP.params.local['CH2_OUT_MAX'] = { value: this.value };
        APP.sendParams();
    }

    ch2_out_min.onchange = function() {
        
        this.value = this.value > 20 ? this.max : this.value;
        this.value = this.value < -20 ? this.min : this.value;
        curN.min = curSl.min = this.value;

        $.cookie('CH2_OUT_MIN', this.value);
        APP.params.local['CH2_OUT_MIN'] = { value: this.value };
        APP.sendParams();
    }

    $("#cavity_lock").click(function() {

        var checkBox = $(this).is(':checked');
        $.cookie('CAV_LOCK', checkBox);
        
        APP.params.local['CAV_LOCK'] = { value: checkBox };
        APP.sendParams();
    });

    tran_lvl.onchange = function() {
        
        this.value = this.value > 20 ? this.max : this.value;
        this.value = this.value < -20 ? this.min : this.value;

        $.cookie('TRANS_LVL', this.value);
        APP.params.local['TRANS_LVL'] = { value: this.value };
        APP.sendParams();
    }

    $("#wlm_lock").click(function() {

        var checkBox = $(this).is(':checked');
        $.cookie('WLM_LOCK', checkBox);
        trg_msg.style.display = "none";
        
        APP.params.local['WLM_LOCK'] = { value: checkBox };
        APP.sendParams();
    });

    $("#target").click(function() {
        
        trg_msg.style.display = "none";

        let txt = 'Target [THz]: ' + '&emsp;&ensp;&nbsp;';
        targ_freq_txt.innerHTML = txt.concat(" ", APP.params.orig['FREQ'].value);
        $.cookie('TARGET_FREQUENCY', APP.params.orig['FREQ'].value);
        APP.params.local['TARGET_FREQUENCY'] = { value: true };
        APP.params.orig['TARGET_FREQUENCY'] = { value: APP.params.orig['FREQ'].value };
        APP.sendParams();
    });

    $("#set_ref").click(function() {
        
        APP.params.local['SET_REF'] = { value: true };
        APP.sendParams();
    });

    $("#piezo_lock").click(function() {

        var checkBox = $(this).is(':checked');
        $.cookie('PIEZO_FEED', checkBox);
        
        APP.params.local['PIEZO_FEED'] = { value: checkBox };
        APP.sendParams();
    });

    $("#curr_lock").click(function() {

        var checkBox = $(this).is(':checked');
        $.cookie('CUR_FEED', checkBox);
        
        APP.params.local['CUR_FEED'] = { value: checkBox };
        APP.sendParams();
    });

    $("#laser_drift").click(function() {

        var checkBox = $(this).is(':checked');
        $.cookie('LASER_DRIFT', checkBox);
        
        APP.params.local['LASER_DRIFT'] = { value: checkBox };
        APP.sendParams();
    });

    $("#transfer_lock").click(function() {

        $("#digi_msg").css('display', 'none');
        var checkBox = $(this).is(':checked');
        $.cookie('TRANSFER_LOCK', checkBox);
        
        APP.params.local['TRANSFER_LOCK'] = { value: checkBox };
        APP.sendParams();
    });

    pzSl.oninput = function() {
        
        pzN.value = this.value;
        $.cookie('CH1_OUT_OFFSET', this.value);
        APP.params.local['CH1_OUT_OFFSET'] = { value: this.value };
        APP.sendParams();
    }

    pzN.oninput = function() {
        
        // this.value = this.value > ch1_out_max.value ? ch1_out_max.value : this.value;
        // this.value = this.value < ch1_out_min.value ? ch1_out_min.value : this.value;
        pzSl.value = this.value;

        $.cookie('CH1_OUT_OFFSET', this.value);
        APP.params.local['CH1_OUT_OFFSET'] = { value: this.value };
        APP.sendParams();
    }

    curSl.oninput = function() {
        
        curN.value = this.value;
        $.cookie('CH2_OUT_OFFSET', this.value);
        APP.params.local['CH2_OUT_OFFSET'] = { value: this.value };
        APP.sendParams();
    }

    curN.oninput = function() {
        
        // this.value = this.value > this.max ? this.max : this.value;
        // this.value = this.value < this.min ? this.min : this.value;
        curSl.value = this.value;

        $.cookie('CH2_OUT_OFFSET', this.value);
        APP.params.local['CH2_OUT_OFFSET'] = { value: this.value };
        APP.sendParams();
    }

    ip.onchange = function() {
        
        $.cookie('WLM_IP', this.value);
        APP.params.local['WLM_IP'] = { value: this.value };
        APP.sendParams();
    }

    port.onchange = function() {
        
        $.cookie('WLM_PORT', this.value);
        APP.params.local['WLM_PORT'] = { value: this.value };
        APP.sendParams();
    }

    $("#WLM_RUN").click(function() {

        var checkBox = $(this).is(':checked');
        if(checkBox) {
            $("#wlm_info").css('display', 'block');
        } else {
            $("#wlm_info").css('display', 'none');
        }
        $.cookie('WLM_RUN', checkBox);
        APP.params.orig['WLM_RUN'] = { value: checkBox };
        APP.params.local['WLM_RUN'] = { value: checkBox };
        APP.sendParams();
    });

    $("#prec").change(function() {
        var val = $(this).children("option:selected").val();
        $.cookie('PREC', val);
        APP.params.local['PREC'] = { value: val };
        APP.sendParams();
    });

    $("#WLM_CH").change(function() {
        var val = $(this).children("option:selected").val();
        $.cookie('WLM_CH', val);
        APP.params.local['WLM_CH'] = { value: val };
        APP.sendParams();
    });

    exp_up.oninput = function() {
        
        this.value = this.value > 9999 ? this.max : this.value;
        this.value = this.value < 2 ? this.min : this.value;

        $.cookie('EXP_UP', this.value);
        APP.params.local['EXP_UP'] = { value: this.value };
        APP.sendParams();
    }

    exp_down.oninput = function() {
        
        this.value = this.value > 9999 ? this.max : this.value;
        this.value = this.value < 0 ? this.min : this.value;

        $.cookie('EXP_DOWN', this.value);
        APP.params.local['EXP_DOWN'] = { value: this.value };
        APP.sendParams();
    }

    $("#exp_auto").click(function() {

        var checkBox = $(this).is(':checked');
        $.cookie('EXP_AUTO', checkBox);
        
        APP.params.local['EXP_AUTO'] = { value: checkBox };
        APP.params.orig['EXP_AUTO'] = { value: checkBox };
        APP.sendParams();
    });

    $("#switch_mode").click(function() {

        var checkBox = $(this).is(':checked');
        $.cookie('SWITCH_MODE', checkBox);
        
        APP.params.local['SWITCH_MODE'] = { value: checkBox };
        APP.sendParams();
    });

    ip_digi.onchange = function() {
        
        $.cookie('DIGI_IP', this.value);
        APP.params.local['DIGI_IP'] = { value: this.value };
        APP.sendParams();
    }

    port_digi.onchange = function() {
        
        $.cookie('DIGI_PORT', this.value);
        APP.params.local['DIGI_PORT'] = { value: this.value };
        APP.sendParams();
    }

    $("#digi_run").click(function() {

        var checkBox = $(this).is(':checked');
        $("#digi_msg").css('display', 'none');
        $.cookie('DIGI_RUN', checkBox);
        APP.params.orig['DIGI_RUN'] = { value: checkBox };
        APP.params.local['DIGI_RUN'] = { value: checkBox };
        APP.sendParams();
    });

    ptp_lvl.onchange = function() {
        
        $.cookie('PTP_LVL', this.value);
        APP.params.local['PTP_LVL'] = { value: this.value };
        APP.sendParams();
    }

    APP.drawGraphGrid();
    APP.drawSpecGraphGrid();

    // Bind to the window resize event to redraw the graph; trigger that event to do the first drawing
    $(window).resize(function() {
        
        APP.drawGraphGrid();
        APP.drawSpecGraphGrid();
        
        // $('#global_container').offset({ left: (window_width - $('#global_container').width()) / 2 });

        // Resize the graph holders
        $('.plot').css($('#graph_grid').css(['height', 'width']));
        $('.plot').css($('#spec_graph_grid').css(['height', 'width']));

        // Hide all graphs, they will be shown next time signal data is received
        $('#graphs .plot').hide();
        $('#spec_graph .plot').hide();
    }).resize();
    
    // Stop the application when page is unloaded. it is last function is running
    $(window).on('beforeunload', function() {
        
        APP.ws.onclose = function() {}; // disable onclose handler first
        APP.ws.close();
        $.ajax({
            url: APP.config.stop_app_url,
            async: false
        });

        if($("body").hasClass("dark-mode")) {
            $.cookie("mode", "dark");
        }else {
            $.cookie("mode", "light");
        }

        $.cookie('SERVER_RUN', APP.params.orig['SERVER_RUN'].value);

        if($("#CH1_IN_SHOW").data('checked')) {
            $.cookie('CH1_IN_SHOW', "true");
        }else {
            $.cookie('CH1_IN_SHOW', "false");
        }

        if($("#CH2_IN_SHOW").data('checked')) {
            $.cookie('CH2_IN_SHOW', "true");
        }else {
            $.cookie('CH2_IN_SHOW', "false");
        }

        $.cookie('TIME_SCALE', APP.params.orig['TIME_SCALE'].value);
        $.cookie('VOLT_SCALE', APP.params.orig['VOLT_SCALE'].value);

        if($("#CH1_IN_PROBE").children("option:selected").val() == 0) {
            $.cookie('CH1_IN_PROBE', 0);
        }else {
            $.cookie('CH1_IN_PROBE', 1);
        }

        if($("#CH1_IN_GAIN").children("option:selected").val() == "0") {
            $.cookie('CH1_IN_GAIN', "0");
        }else {
            $.cookie('CH1_IN_GAIN', "1");
        }

        if($("#CH2_IN_PROBE").children("option:selected").val() == "0") {
            $.cookie('CH2_IN_PROBE', "0");
        }else {
            $.cookie('CH2_IN_PROBE', "1");
        }

        if($("#CH2_IN_GAIN").children("option:selected").val() == "0") {
            $.cookie('CH2_IN_GAIN', "0");
        }else {
            $.cookie('CH2_IN_GAIN', "1");
        }

        $.cookie('CH1_OUT_MAX', ch1_out_max.value);
        $.cookie('CH1_OUT_MIN', ch1_out_min.value);
        $.cookie('CH2_OUT_MAX', ch2_out_max.value);
        $.cookie('CH2_OUT_MIN', ch2_out_min.value);

        $.cookie('CAV_LOCK', $('#cavity_lock').is(':checked'));
        $.cookie('TRANS_LVL', tran_lvl.value);
        $.cookie('WLM_LOCK', $('#wlm_lock').is(':checked'));
        $.cookie('PIEZO_FEED', $('#piezo_lock').is(':checked'));
        $.cookie('CUR_FEED', $('#curr_lock').is(':checked'));
        $.cookie('LASER_DRIFT', $('#laser_drift').is(':checked'));
        $.cookie('TRANSFER_LOCK', $('#transfer_lock').is(':checked'));

        $.cookie('CH1_OUT_OFFSET', pzSl.value);
        $.cookie('CH2_OUT_OFFSET', curSl.value);

        $.cookie('WLM_IP', ip.value);
        $.cookie('WLM_PORT', port.value);
        $.cookie('WLM_RUN', APP.params.orig['WLM_RUN'].value);
        $.cookie('PREC', $("#prec").children("option:selected").val());
        $.cookie('WLM_CH', $("#WLM_CH").children("option:selected").val());
        $.cookie('EXP_UP', exp_up.value);
        $.cookie('EXP_DOWN', exp_down.value);
        $.cookie('EXP_AUTO', $('#exp_auto').is(':checked'));
        $.cookie('SWITCH_MODE', $('#switch_mode').is(':checked'));

        $.cookie('DIGI_IP', ip_digi.value);
        $.cookie('DIGI_PORT', port_digi.value);
        $.cookie('DIGI_RUN', APP.params.orig['DIGI_RUN'].value);
        $.cookie('PTP_LVL', ptp_lvl.value);
        
        APP.unexpectedClose = false;
    });

    // Everything prepared, start application
    APP.startApp();
});
